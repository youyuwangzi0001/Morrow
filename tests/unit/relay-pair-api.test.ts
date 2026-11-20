import { createECDH, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  RELAY_DISABLED,
  PAIR_TTL_SECONDS,
  isExpired,
  issuePairTicket,
  listPairDevices,
  remainingMs,
  revokePairDevice
} from '../../src/relay/pair-api'
import { DEVICE_REVOKED, PairingError, PairingService, TICKET_TTL_MS } from '../../src/relay/pairing'

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
