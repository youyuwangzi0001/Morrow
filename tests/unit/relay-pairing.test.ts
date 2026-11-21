/**
 * relay 配对域单测：票据签发/校验、六位码、配对 API、设备表持久化、长期密钥与强制配对。
 * 
 * 由 relay-pairing / relay-pair-api / relay-device-store / relay-keystore 四个文件合并；
 * 每个 it 的标题与断言原样保留，各来源的文件级说明保留在对应段前。
 * 每段各自包一层 describe：原文件级的 helper（phoneKeys / clock / makeService、dataDir / dirs 等）
 * 在当前作用域内重名，包层后各自可见，语义与合并前一致。
 */
import { createECDH, randomBytes } from 'node:crypto'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { CODE_ATTEMPTS_EXCEEDED, CODE_MISMATCH, DEVICE_REVOKED, MAX_CODE_ATTEMPTS, PairingError, PairingService, TICKET_EXPIRED, TICKET_INVALID, TICKET_TTL_MS, TICKET_USED, derivePairingCode, RELAY_DISABLED, PAIR_TTL_SECONDS, isExpired, issuePairTicket, listPairDevices, remainingMs, revokePairDevice, clearDevices, devicesPathIn, loadDevices, saveDevices, type SafeStorageLike, type PairedDevice, deleteKey, keyPathIn, loadOrCreateKey } from '../../src/main/relay-pairing'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRelay } from '../../src/main/relay-server'

// ───── 来源：tests/unit/relay-pairing.test.ts ─────
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
describe('配对与票据', () => {
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
})

// ───── 来源：tests/unit/relay-pair-api.test.ts ─────
/**
 * 设置页「手机配对」的后端逻辑（E2d）。
 *
 * ## 这一层为什么需要单独测
 *
 * E2c 让票据里有了证书指纹，但 `issueTicket` 在桌面**没有任何生产调用方** ——
 * 也就是说用户无法从界面上生成配对码，真机链路仍然跑不起来。
 *
 * 把 IPC 逻辑抽进 `pair-api.ts` 的直接动机就是「能测」：
 * `ipcMain.handle` 的回调在单元测试里既起不来也断言不了。
 * 抽出来之后，这里跑的是**真实的 `PairingService`**，不是替身。
 *
 * ## 必须覆盖的三个失败状态
 *
 * 1. 远程通道没开（`pairing === null`）→ `RELAY_DISABLED`，**不能**临时造一个服务；
 * 2. 指纹缺失 → `hasFingerprint: false`，界面要当场提示而不是让用户白扫；
 * 3. 撤销后 `requirePaired` 立即抛 `DEVICE_REVOKED`（同一请求内生效）。
 */
describe('配对 API', () => {
  let clock = 1_700_000_000_000

  function makeService(opts: { tlsFingerprint?: string } = {}): PairingService {
    clock = 1_700_000_000_000
    return new PairingService({
      secret: randomBytes(32),
      now: () => clock,
      ...(opts.tlsFingerprint ? { tlsFingerprint: opts.tlsFingerprint } : {})
    })
  }

  function phoneKeys() {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    return {
      pub: ecdh.getPublicKey().toString('base64'),
      secretWith: (desktopPub: string) => ecdh.computeSecret(Buffer.from(desktopPub, 'base64'))
    }
  }

  describe('远程通道没开时：明确报错，不偷偷造一个服务', () => {
    it('@core:relay issue 返回 RELAY_DISABLED', () => {
      const r = issuePairTicket(null, { deviceId: 'd', phonePubKey: phoneKeys().pub })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.code).toBe(RELAY_DISABLED)
        // 提示要能指导用户下一步，而不是「操作失败」
        expect(r.error.message).toContain('远程通道')
      }
    })

    it('@core:relay list 返回 RELAY_DISABLED', () => {
      const r = listPairDevices(null)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe(RELAY_DISABLED)
    })

    it('@core:relay revoke 返回 RELAY_DISABLED', () => {
      const r = revokePairDevice(null, 'd')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe(RELAY_DISABLED)
    })
  })

  describe('签发票据', () => {
    it('@core:relay 返回 qr / code / expiresAt / nonce 且指纹标记为 true', () => {
      const svc = makeService({ tlsFingerprint: 'FP_TEST_VALUE' })
      const phone = phoneKeys()
      const r = issuePairTicket(svc, { deviceId: 'dev-1', phonePubKey: phone.pub, relayHint: '192.168.1.5:7788' })
      expect(r.ok).toBe(true)
      if (!r.ok) return

      expect(r.data.qr.length).toBeGreaterThan(30)
      expect(r.data.code).toMatch(/^\d{6}$/)
      expect(r.data.nonce).toHaveLength(32) // randomBytes(16).toString('hex')
      expect(r.data.hasFingerprint).toBe(true)
      // expiresAt 必须是票据自己的 exp，不是「现在 + TTL」重算
      expect(r.data.expiresAt).toBe(clock + TICKET_TTL_MS)
    })

    it('@core:relay qr 能被桌面自己的 parseTicket 解开，且字段齐全', () => {
      // 这条守的是「界面拿到的 qr 与内部票据是同一份数据」。
      // 如果哪天改成手挑字段拼 qr，内部有值而界面拿到的是残的。
      const svc = makeService({ tlsFingerprint: 'FP_TEST_VALUE' })
      const phone = phoneKeys()
      const r = issuePairTicket(svc, { deviceId: 'dev-1', phonePubKey: phone.pub, relayHint: '192.168.1.5:7788' })
      expect(r.ok).toBe(true)
      if (!r.ok) return

      const ticket = PairingService.parseTicket(r.data.qr)
      expect(ticket.deviceId).toBe('dev-1')
      expect(ticket.pubKey).toBe(phone.pub)
      expect(ticket.nonce).toBe(r.data.nonce)
      expect(ticket.exp).toBe(r.data.expiresAt)
      expect(ticket.fingerprint).toBe('FP_TEST_VALUE')
      expect(ticket.relayHint).toBe('192.168.1.5:7788')
    })

    it('@core:relay 指纹缺失时 hasFingerprint 为 false（界面必须提示，不能让用户白扫）', () => {
      // 生产里这对应「局域网直连没起来」：证书没载入 → 没指纹 →
      // 手机侧会拒绝完成配对。界面若不提示，用户会以为是自己操作错了。
      const svc = makeService() // 不注入指纹
      const r = issuePairTicket(svc, { deviceId: 'dev-1', phonePubKey: phoneKeys().pub })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.data.hasFingerprint).toBe(false)
      // 票据里就不该有该字段（而不是空串）
      expect('fingerprint' in PairingService.parseTicket(r.data.qr)).toBe(false)
    })

    it('@core:relay 空 deviceId 或空公钥被拒绝，且错误码是 TICKET_INVALID', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      for (const input of [
        { deviceId: '', phonePubKey: phoneKeys().pub },
        { deviceId: 'dev-1', phonePubKey: '' }
      ]) {
        const r = issuePairTicket(svc, input)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error.code).toBe('TICKET_INVALID')
      }
    })

    it('@core:relay 公钥格式非法时抛 PairingError 并被翻成 Result，不是抛到 IPC 层', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const r = issuePairTicket(svc, { deviceId: 'dev-1', phonePubKey: 'not-a-key' })
      expect(r.ok).toBe(false)
    })

    it('@core:relay 每次签发都是新 nonce（同一秒内连续点两次不会撞）', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const phone = phoneKeys()
      const seen = new Set<string>()
      for (let i = 0; i < 20; i++) {
        const r = issuePairTicket(svc, { deviceId: 'd', phonePubKey: phone.pub })
        if (r.ok) seen.add(r.data.nonce)
      }
      expect(seen.size).toBe(20)
    })
  })

  describe('设备列表', () => {
    it('@core:relay 已配对设备出现在列表里，且不含 sessionKey', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const phone = phoneKeys()
      const issued = issuePairTicket(svc, { deviceId: 'dev-1', phonePubKey: phone.pub })
      expect(issued.ok).toBe(true)
      if (!issued.ok) return

      svc.completePairing(issued.data.nonce, phone.pub, '我的手机')

      const r = listPairDevices(svc)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.data).toHaveLength(1)
      expect(r.data[0].deviceId).toBe('dev-1')
      expect(r.data[0].name).toBe('我的手机')
      expect(JSON.stringify(r.data)).not.toContain('sessionKey')
    })

    it('@core:relay 没有设备时返回空数组而不是报错', () => {
      const r = listPairDevices(makeService({ tlsFingerprint: 'FP' }))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual([])
    })
  })

  describe('撤销设备', () => {
    it('@core:relay 撤销后 requirePaired 立即抛 DEVICE_REVOKED（同一请求内生效）', () => {
      // 这是蓝图验收原文第四条。E2c 之前 pairing.ts 已经有这个保证，
      // 但**界面没有入口触发它** —— 用户无法撤销一台手机。
      const svc = makeService({ tlsFingerprint: 'FP' })
      const phone = phoneKeys()
      const issued = issuePairTicket(svc, { deviceId: 'dev-1', phonePubKey: phone.pub })
      expect(issued.ok).toBe(true)
      if (!issued.ok) return
      svc.completePairing(issued.data.nonce, phone.pub)

      // 撤销前可用
      expect(() => svc.requirePaired('dev-1')).not.toThrow()

      const r = revokePairDevice(svc, 'dev-1')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data.revoked).toBe(true)

      // 撤销后立刻不可用 —— 不等到下次握手、不等到重启
      try {
        svc.requirePaired('dev-1')
        throw new Error('撤销后仍可用，这是安全漏洞')
      } catch (err) {
        expect(err).toBeInstanceOf(PairingError)
        expect((err as PairingError).code).toBe(DEVICE_REVOKED)
      }
    })

    it('@core:relay 撤销不存在的设备返回 revoked: false（而不是假装成功）', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const r = revokePairDevice(svc, 'never-paired')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data.revoked).toBe(false)
    })

    it('@core:relay 空 deviceId 被拒绝', () => {
      const r = revokePairDevice(makeService({ tlsFingerprint: 'FP' }), '')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('INVALID_DEVICE_ID')
    })

    it('@core:relay 撤销一台不影响另一台', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const a = phoneKeys()
      const b = phoneKeys()
      const ia = issuePairTicket(svc, { deviceId: 'dev-a', phonePubKey: a.pub })
      const ib = issuePairTicket(svc, { deviceId: 'dev-b', phonePubKey: b.pub })
      if (!ia.ok || !ib.ok) throw new Error('签发失败')
      svc.completePairing(ia.data.nonce, a.pub)
      svc.completePairing(ib.data.nonce, b.pub)

      revokePairDevice(svc, 'dev-a')

      expect(() => svc.requirePaired('dev-a')).toThrow()
      expect(() => svc.requirePaired('dev-b')).not.toThrow()
    })
  })

  describe('过期判定', () => {
    it('@core:relay expiresAt 取自票据，倒计时随 now 递减', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const r = issuePairTicket(svc, { deviceId: 'd', phonePubKey: phoneKeys().pub })
      expect(r.ok).toBe(true)
      if (!r.ok) return

      expect(remainingMs(r.data.expiresAt, clock)).toBe(TICKET_TTL_MS)
      expect(remainingMs(r.data.expiresAt, clock + 30_000)).toBe(TICKET_TTL_MS - 30_000)
      // 过期后不能出现负数（界面显示「-3 秒」会很怪）
      expect(remainingMs(r.data.expiresAt, clock + TICKET_TTL_MS + 5_000)).toBe(0)
    })

    it('@core:relay 到期之后 isExpired 为 true，之前为 false', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const r = issuePairTicket(svc, { deviceId: 'd', phonePubKey: phoneKeys().pub })
      if (!r.ok) throw new Error('签发失败')

      expect(isExpired(r.data.expiresAt, clock)).toBe(false)
      expect(isExpired(r.data.expiresAt, clock + TICKET_TTL_MS - 1)).toBe(false)
      // 恰好等于 exp 时仍有效（与 pairing.ts 的 `now > exp` 判定一致）
      expect(isExpired(r.data.expiresAt, clock + TICKET_TTL_MS)).toBe(false)
      expect(isExpired(r.data.expiresAt, clock + TICKET_TTL_MS + 1)).toBe(true)
    })

    it('@core:relay PAIR_TTL_SECONDS 与票据 TTL 一致（界面不写死 90）', () => {
      expect(PAIR_TTL_SECONDS).toBe(90)
      expect(PAIR_TTL_SECONDS * 1000).toBe(TICKET_TTL_MS)
    })

    it('@core:relay 过期票据再确认会被 pairing 拒绝（界面过期只是显示，服务端才是裁判）', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const issued = issuePairTicket(svc, { deviceId: 'd', phonePubKey: phoneKeys().pub })
      if (!issued.ok) throw new Error('签发失败')

      // 界面用同一份 expiresAt 判断过期
      expect(isExpired(issued.data.expiresAt, clock + TICKET_TTL_MS + 1)).toBe(true)
      // 服务端也要拒绝 —— 只靠界面判断是可绕过的
      clock += TICKET_TTL_MS + 1
      expect(() => svc.verifyEcho(issued.data.nonce)).toThrow(/过期/)
    })
  })
})

// ───── 来源：tests/unit/relay-device-store.test.ts ─────
/**
 * B3 第四批验收：已配对设备表持久化。
 *
 * 为什么这块必须单独测：B3 第一批只让「桌面公钥」跨重启不变，
 * 设备表仍在内存里。探针实测：配对 1 台 → 重启 → listDevices() 返回 0，
 * requirePaired() 抛 DEVICE_REVOKED。用户的观感是「每天开电脑都要重新扫码」。
 *
 * 真正要防的两个缺陷：
 * 1. 重启后设备消失（必须免扫码恢复）
 * 2. **撤销后重启，设备从文件里复活** —— 这是安全漏洞，不是体验问题
 */
describe('设备表持久化', () => {
  const XOR_KEY = 0x5a
  function fakeSafeStorage(available = true): SafeStorageLike {
    return {
      isEncryptionAvailable: () => available,
      encryptString: (t: string) => Buffer.from([...Buffer.from(t, 'utf8')].map((b) => b ^ XOR_KEY)),
      decryptString: (b: Buffer) => Buffer.from([...b].map((c) => c ^ XOR_KEY)).toString('utf8')
    }
  }

  let dataDir = ''
  const dirs: string[] = []
  let clock = 1_700_000_000_000

  function newDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'morrow-devstore-'))
    dirs.push(d)
    return d
  }

  /** 手机密钥对 */
  function phoneKeys() {
    const e = createECDH('prime256v1')
    e.generateKeys()
    return e.getPublicKey().toString('base64')
  }

  /** 造一个 PairingService，模拟「一次应用启动」 */
  function boot(opts: { privateKey?: string; safe?: SafeStorageLike; dir?: string } = {}) {
    const dir = opts.dir ?? dataDir
    const safe = opts.safe ?? fakeSafeStorage()
    const pairing = new PairingService({
      secret: randomBytes(32),
      now: () => clock,
      ...(opts.privateKey ? { privateKey: opts.privateKey } : {}),
      devices: {
        load: () => loadDevices({ dataDir: dir, safeStorage: safe }),
        save: (devices: PairedDevice[]) => void saveDevices({ dataDir: dir, safeStorage: safe }, devices)
      }
    })
    return { pairing, dir, safe }
  }

  beforeEach(() => {
    dataDir = newDir()
    clock = 1_700_000_000_000
  })

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  // ───────────────── 核心：重启后设备仍在 ─────────────────

  describe('重启后设备仍在（免扫码恢复）', () => {
    it('@core:relay 配对一台设备 → 重启 → 设备表仍有它', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      first.pairing.completePairing(ticket.nonce, phone, '我的手机')
      expect(first.pairing.listDevices()).toHaveLength(1)

      // 模拟重启：同一 dataDir 新建实例
      const second = boot()
      const devices = second.pairing.listDevices()
      expect(devices).toHaveLength(1)
      expect(devices[0].deviceId).toBe('phone-1')
      expect(devices[0].name).toBe('我的手机')
    })

    it('@core:relay 重启后 requirePaired 不抛错（手机能直接重连）', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      first.pairing.completePairing(ticket.nonce, phone)

      const second = boot()
      expect(() => second.pairing.requirePaired('phone-1')).not.toThrow()
    })

    it('@core:relay 重启后 sessionKey 不变，老签名仍然有效', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      const device = first.pairing.completePairing(ticket.nonce, phone)

      const ts = String(clock)
      const sig = PairingService.signRequest(device.sessionKey, 'phone-1', 'session:list', ts)

      const second = boot()
      // 用重启前的签名去验证 —— 必须通过
      expect(() => second.pairing.verifyRequest('phone-1', 'session:list', ts, sig)).not.toThrow()
    })

    it('@core:relay 多台设备都能恢复', () => {
      const first = boot()
      for (const id of ['phone-a', 'phone-b', 'phone-c']) {
        const pub = phoneKeys()
        const { ticket } = first.pairing.issueTicket(id, pub)
        first.pairing.completePairing(ticket.nonce, pub)
      }

      const second = boot()
      expect(second.pairing.listDevices()).toHaveLength(3)
      for (const id of ['phone-a', 'phone-b', 'phone-c']) {
        expect(() => second.pairing.requirePaired(id)).not.toThrow()
      }
    })
  })

  // ───────────────── 安全关键：撤销必须持久 ─────────────────

  describe('撤销必须持久（否则重启后设备复活）', () => {
    it('@core:relay 撤销后重启，设备不会回来', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      first.pairing.completePairing(ticket.nonce, phone)

      first.pairing.revokeDevice('phone-1')
      expect(first.pairing.listDevices()).toHaveLength(0)

      const second = boot()
      expect(second.pairing.listDevices()).toHaveLength(0)
      try {
        second.pairing.requirePaired('phone-1')
        throw new Error('应当拒绝')
      } catch (err) {
        expect((err as PairingError).code).toBe(DEVICE_REVOKED)
      }
    })

    it('@core:relay 撤销一台不影响其他设备，重启后状态一致', () => {
      const first = boot()
      const pa = phoneKeys()
      const pb = phoneKeys()
      const ta = first.pairing.issueTicket('phone-a', pa)
      const tb = first.pairing.issueTicket('phone-b', pb)
      first.pairing.completePairing(ta.ticket.nonce, pa)
      first.pairing.completePairing(tb.ticket.nonce, pb)

      first.pairing.revokeDevice('phone-a')

      const second = boot()
      const ids = second.pairing.listDevices().map((d) => d.deviceId)
      expect(ids).toEqual(['phone-b'])
    })

    it('@core:relay 撤销不存在的设备不写盘（不产生无谓 IO）', () => {
      const first = boot()
      expect(first.pairing.revokeDevice('nope')).toBe(false)
      // 没有设备时文件不该被创建
      expect(existsSync(devicesPathIn(first.dir))).toBe(false)
    })
  })

  // ───────────────── 文件格式与安全 ─────────────────

  describe('落盘内容与安全', () => {
    it('@core:relay 设备表加密落盘：文件里不含 sessionKey 明文', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      const device = first.pairing.completePairing(ticket.nonce, phone)

      const raw = readFileSync(devicesPathIn(first.dir), 'utf8')
      expect(raw).not.toContain(device.sessionKey)
      expect(raw).not.toContain('phone-1')
    })

    it('@core:relay safeStorage 不可用时不落盘（宁可重配也不明文存 sessionKey）', () => {
      const phone = phoneKeys()
      const unavailable = fakeSafeStorage(false)
      const s = boot({ safe: unavailable })
      const { ticket } = s.pairing.issueTicket('phone-1', phone)
      s.pairing.completePairing(ticket.nonce, phone)

      expect(existsSync(devicesPathIn(s.dir))).toBe(false)
      // 内存里仍然可用，只是重启会丢
      expect(s.pairing.listDevices()).toHaveLength(1)
    })

    it('@core:relay 文件损坏时退化为空表，但不删除损坏文件', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      first.pairing.completePairing(ticket.nonce, phone)

      // 破坏文件
      writeFileSync(devicesPathIn(first.dir), Buffer.from('garbage'))

      const second = boot()
      expect(second.pairing.listDevices()).toHaveLength(0)
      // 文件还在（可能是临时读失败，不该直接丢弃）
      expect(existsSync(devicesPathIn(first.dir))).toBe(true)
    })

    it('@core:relay 不注入 devices 钩子时退化为纯内存（向后兼容）', () => {
      const phone = phoneKeys()
      const svc = new PairingService({ secret: randomBytes(32), now: () => clock })
      const { ticket } = svc.issueTicket('phone-1', phone)
      svc.completePairing(ticket.nonce, phone)
      expect(svc.listDevices()).toHaveLength(1)
      // 没有钩子 → 不写任何文件
      expect(existsSync(devicesPathIn(dataDir))).toBe(false)
    })

    it('@core:relay clearDevices 能清空（用户解除全部设备）', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      first.pairing.completePairing(ticket.nonce, phone)
      expect(existsSync(devicesPathIn(first.dir))).toBe(true)

      expect(clearDevices({ dataDir: first.dir, safeStorage: fakeSafeStorage() })).toBe(true)
      expect(existsSync(devicesPathIn(first.dir))).toBe(false)
    })
  })

  // ───────────────── 绕过防护 ─────────────────

  describe('损坏数据不会让服务崩溃或放行未配对设备', () => {
    it('@core:relay 设备条目缺字段时被丢弃，不影响其他有效条目', () => {
      const safe = fakeSafeStorage()
      const phone = phoneKeys()
      const first = boot({ safe })
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      first.pairing.completePairing(ticket.nonce, phone)

      // 手工写入一条合法 + 两条非法
      saveDevices(
        { dataDir: first.dir, safeStorage: safe },
        [
          ...loadDevices({ dataDir: first.dir, safeStorage: safe }),
          { deviceId: '' } as PairedDevice,
          { deviceId: 'x', pubKey: 'p' } as PairedDevice
        ]
      )

      const second = boot({ safe })
      const ids = second.pairing.listDevices().map((d) => d.deviceId)
      expect(ids).toEqual(['phone-1'])
    })

    it('@core:relay 空设备表写入后能读回空数组', () => {
      const safe = fakeSafeStorage()
      saveDevices({ dataDir, safeStorage: safe }, [])
      expect(loadDevices({ dataDir, safeStorage: safe })).toEqual([])
    })
  })
})

// ───── 来源：tests/unit/relay-keystore.test.ts ─────
/**
 * B3 第一批：长期密钥持久化 + 强制配对。
 *
 * 这两条直接来自 B2 报告 §7 的限制 1 和 2：
 * 1. `pairing` 参数可选 → 不传就静默退化为无鉴权（生产环境等于没有鉴权）；
 * 2. 桌面密钥只在内存 → 重启后所有已配对设备失效。
 *
 * 两条都是「功能看起来在、实际不可用」的类型，所以测试必须验证**跨进程**的事实：
 * 用同一个 dataDir 构造两个 PairingService 实例，模拟「应用重启」。
 */
describe('长期密钥与强制配对', () => {
  let dataDir = ''
  const dirs: string[] = []

  /**
   * 假 safeStorage：XOR 一下当作「加密」，只为验证流程而不依赖 Electron/DPAPI。
   *
   * 注意它与真实 DPAPI 的两个差异，避免误判：
   * - XOR 不改变长度（密文与明文等长 44 字节）；真实 DPAPI 有头部开销。
   * - XOR 对同一明文产生同一密文；DPAPI 每次加密结果不同（含随机 IV）。
   * 所以断言只验证「文件里不含明文私钥」，不验证密文长度或内容特征。
   */
  function fakeSafeStorage(available = true): SafeStorageLike {
    const KEY = 0x5a
    return {
      isEncryptionAvailable: () => available,
      encryptString: (text: string) => Buffer.from([...Buffer.from(text, 'utf8')].map((b) => b ^ KEY)),
      decryptString: (buf: Buffer) => Buffer.from([...buf].map((b) => b ^ KEY)).toString('utf8')
    }
  }

  function newDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'morrow-b3-key-'))
    dirs.push(d)
    return d
  }

  beforeEach(() => {
    dataDir = newDir()
  })

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  // ───────────────── 长期密钥持久化 ─────────────────

  describe('长期密钥持久化', () => {
    it('@core:relay 首次运行生成密钥并落盘', () => {
      const key = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      expect(key.restored).toBe(false)
      expect(existsSync(keyPathIn(dataDir))).toBe(true)
    })

    it('@core:relay 再次载入时复用同一密钥（模拟应用重启）', () => {
      const first = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      const second = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })

      expect(second.restored).toBe(true)
      expect(second.privateKey).toBe(first.privateKey)
      expect(second.publicKey).toBe(first.publicKey)
    })

    it('@core:relay 落盘的私钥是密文，不是明文', () => {
      const key = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      const raw = readFileSync(keyPathIn(dataDir), 'utf8')
      expect(raw).not.toContain(key.privateKey)
      // 明文私钥是 base64 的 P-256 标量（约 43 字符），不应出现在文件里
      expect(raw.includes(key.privateKey.slice(0, 16))).toBe(false)
    })

    it('@core:relay safeStorage 不可用时不写明文文件（宁可本次临时）', () => {
      const key = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage(false) })
      expect(key.restored).toBe(false)
      // 关键：文件根本不落盘
      expect(existsSync(keyPathIn(dataDir))).toBe(false)
    })

    it('@core:relay 文件损坏时不阻塞启动，退化为新密钥', () => {
      loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      // 写入垃圾
      const p = keyPathIn(dataDir)
      writeFileSync(p, Buffer.from('garbage-not-decryptable'))

      const key = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      expect(key.restored).toBe(false)
      expect(key.privateKey).toBeTruthy()
    })

    it('@core:relay deleteKey 能清除持久化密钥', () => {
      loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      expect(deleteKey(dataDir)).toBe(true)
      expect(existsSync(keyPathIn(dataDir))).toBe(false)
      expect(deleteKey(dataDir)).toBe(false)
    })
  })

  // ───────────────── 重启后已配对设备仍有效 ─────────────────

  describe('重启后配对仍有效（这是持久化的真正目的）', () => {
    it('@core:relay 用同一长期密钥重建 PairingService，桌面公钥不变', () => {
      const key = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      const a = new PairingService({ secret: randomBytes(32), privateKey: key.privateKey })

      // 模拟重启：重新载入密钥，构造新实例
      const key2 = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      const b = new PairingService({ secret: randomBytes(32), privateKey: key2.privateKey })

      expect(b.desktopPublicKey()).toBe(a.desktopPublicKey())
    })

    it('@core:relay 重启前手机算出的共享秘密，重启后仍可用（设备无需重配）', () => {
      const key = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })

      // 手机侧密钥对
      const phone = createECDH('prime256v1')
      phone.generateKeys()
      const phonePub = phone.getPublicKey().toString('base64')

      // 重启前：桌面签发票据，手机算出共享秘密
      const before = new PairingService({ secret: randomBytes(32), privateKey: key.privateKey })
      const { ticket } = before.issueTicket('phone-1', phonePub)
      const sharedBefore = phone.computeSecret(Buffer.from(before.desktopPublicKey(), 'base64'))
      const device = before.completePairing(ticket.nonce, phonePub)

      // 重启后：新实例，同一长期密钥
      const key2 = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      const after = new PairingService({ secret: randomBytes(32), privateKey: key2.privateKey })
      const sharedAfter = phone.computeSecret(Buffer.from(after.desktopPublicKey(), 'base64'))

      // 共享秘密一致 → 手机不需要重新配对
      expect(sharedAfter.equals(sharedBefore)).toBe(true)
      expect(device.sessionKey).toBe(sharedBefore.toString('base64'))
    })

    it('@core:relay 不注入私钥时每次都是新密钥（反证持久化确实起作用）', () => {
      const a = new PairingService({ secret: randomBytes(32) })
      const b = new PairingService({ secret: randomBytes(32) })
      expect(a.desktopPublicKey()).not.toBe(b.desktopPublicKey())
    })
  })

  // ───────────────── 强制配对 ─────────────────

  describe('强制配对：不传 pairing 必须拒绝启动', () => {
    it('@core:relay 不带 pairing、不带 allowUnauthenticated → 抛 PAIRING_REQUIRED', async () => {
      await expect(startRelay({ enabled: true, dataDir })).rejects.toMatchObject({ code: 'PAIRING_REQUIRED' })
    })

    it('@core:relay 即使 enabled=false 也先检查配对（避免「关一次再开」绕过）', async () => {
      // 语义选择：配置错误应当在启动配置阶段就暴露，而不是等到真正开监听时。
      await expect(startRelay({ enabled: false, dataDir })).rejects.toMatchObject({ code: 'PAIRING_REQUIRED' })
    })

    it('@core:relay 显式 allowUnauthenticated=true 才允许无鉴权', async () => {
      const h = await startRelay({ enabled: true, dataDir, allowUnauthenticated: true })
      expect(h.listening).toBe(true)
      await h.stop()
    })

    it('@core:relay 传了 pairing 就正常启动', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const h = await startRelay({ enabled: true, dataDir, pairing })
      expect(h.listening).toBe(true)
      await h.stop()
    })
  })

  // ───────────────── 密钥与票据的边界 ─────────────────

  describe('密钥与票据边界', () => {
    it('@core:relay 注入损坏的私钥时退化为新密钥，不崩溃', () => {
      const svc = new PairingService({ secret: randomBytes(32), privateKey: 'not-a-valid-key' })
      expect(svc.desktopPublicKey()).toBeTruthy()
    })

    it('@core:relay 不同长期私钥签发的票据互不通用', () => {
      const k1 = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      const k2 = loadOrCreateKey({ dataDir: newDir(), safeStorage: fakeSafeStorage() })

      const s1 = new PairingService({ secret: randomBytes(32), privateKey: k1.privateKey })
      const s2 = new PairingService({ secret: randomBytes(32), privateKey: k2.privateKey })

      const phone = createECDH('prime256v1')
      phone.generateKeys()
      const { ticket } = s1.issueTicket('p', phone.getPublicKey().toString('base64'))

      // s2 没见过这张票据
      expect(() => s2.verifyEcho(ticket.nonce)).toMatchObject
      try {
        s2.verifyEcho(ticket.nonce)
        throw new Error('应当拒绝')
      } catch (err) {
        expect((err as { code?: string }).code).toBe(TICKET_INVALID)
      }
    })
  })
})
