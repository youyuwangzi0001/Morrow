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
import { createECDH, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteKey, keyPathIn, loadOrCreateKey, type SafeStorageLike } from '../../src/relay/keystore'
import { PairingService, TICKET_INVALID } from '../../src/relay/pairing'
import { startRelay } from '../../src/relay/server'

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