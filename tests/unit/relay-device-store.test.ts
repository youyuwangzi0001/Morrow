import { createECDH, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearDevices, devicesPathIn, loadDevices, saveDevices } from '../../src/relay/device-store'
import type { SafeStorageLike } from '../../src/relay/keystore'
import { DEVICE_REVOKED, PairingError, PairingService, type PairedDevice } from '../../src/relay/pairing'

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