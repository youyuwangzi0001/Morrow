import { createECDH, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditPathIn, readAudit } from '../../src/relay/audit'
import { DEVICE_REVOKED, PairingService } from '../../src/relay/pairing'
import { bindChannel, resetBindings } from '../../src/relay/registry'
import { startRelay, type RelayHandle } from '../../src/relay/server'

/**
 * B2 接入验收：配对与请求签名真的接在 HTTP 请求路径上。
 *
 * 这一层最容易做假：pairing.ts 单测全绿，但 server.ts 根本没调它 ——
 * 于是「配对了才能用」只存在于文档里。
 *
 * 更重要的一条（初版实现真的错了）：只看 `x-morrow-device` 这个明文头
 * 等于**没有鉴权**。审查探针跑出来的结果是「只有 deviceId 也能拿到全部数据」。
 * 所以这里每一条正常路径都要求真实 HMAC 签名，并专门有「冒用 deviceId」的用例。
 */

let dataDir = ''
let relay: RelayHandle | null = null
let pairing: PairingService
let clock = 1_700_000_000_000

/** 一台「手机」：持有自己的私钥与配对后拿到的 sessionKey */
interface Phone {
  id: string
  sessionKey: string
}

function phoneKeys() {
  const e = createECDH('prime256v1')
  e.generateKeys()
  return { pub: e.getPublicKey().toString('base64'), ecdh: e }
}

beforeEach(() => {
  clock = 1_700_000_000_000
  dataDir = mkdtempSync(join(tmpdir(), 'morrow-relay-pair-'))
  resetBindings()
  pairing = new PairingService({ secret: randomBytes(32), now: () => clock })
  bindChannel('session:list', async () => [{ id: 's-1' }])
})

afterEach(async () => {
  if (relay) {
    await relay.stop()
    relay = null
  }
  rmSync(dataDir, { recursive: true, force: true })
})

/** 完成一次完整配对，返回可用的手机凭据 */
function pairDevice(id = 'phone-1'): Phone {
  const { pub } = phoneKeys()
  const { ticket } = pairing.issueTicket(id, pub)
  const device = pairing.completePairing(ticket.nonce, pub, '测试手机')
  return { id, sessionKey: device.sessionKey }
}

/** 带真实签名发一次请求 */
async function call(channel: string, phone: Phone | null, payload: unknown = {}, opts: { tamper?: 'sig' | 'ts' | 'channel'; noSig?: boolean } = {}) {
  const ts = String(clock)
  const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' }

  if (phone) {
    headers['x-morrow-device'] = phone.id
    headers['x-morrow-timestamp'] = ts
    if (!opts.noSig) {
      const signChannel = opts.tamper === 'channel' ? 'other:channel' : channel
      let sig = PairingService.signRequest(phone.sessionKey, phone.id, signChannel, ts)
      if (opts.tamper === 'sig') sig = sig.slice(0, -4) + 'AAAA'
      headers['x-morrow-signature'] = sig
      if (opts.tamper === 'ts') headers['x-morrow-timestamp'] = String(clock + 120_000)
    }
  }

  const res = await fetch(`http://127.0.0.1:${relay!.port}/relay/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('第四道判定：配对接在请求路径上', () => {
  it('@core:relay 未配对设备被拒绝（403 DEVICE_REVOKED）', async () => {
    relay = await startRelay({ enabled: true, dataDir, pairing })
    const r = await call('session:list', { id: 'unknown-device', sessionKey: 'anything' })
    expect(r.status).toBe(403)
    expect((r.body.error as { code: string }).code).toBe(DEVICE_REVOKED)
  })

  it('@core:relay 不带任何设备头也被拒绝', async () => {
    relay = await startRelay({ enabled: true, dataDir, pairing })
    const r = await call('session:list', null)
    expect(r.status).toBe(403)
  })

  it('@core:relay 配对成功 + 正确签名可以调用', async () => {
    const phone = pairDevice()
    relay = await startRelay({ enabled: true, dataDir, pairing })
    const r = await call('session:list', phone)
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.data).toEqual([{ id: 's-1' }])
  })

  it('@core:relay 撤销后下一次请求立即 403（不等重连）', async () => {
    const phone = pairDevice()
    relay = await startRelay({ enabled: true, dataDir, pairing })

    expect((await call('session:list', phone)).status).toBe(200)

    pairing.revokeDevice(phone.id)

    const after = await call('session:list', phone)
    expect(after.status).toBe(403)
    expect((after.body.error as { code: string }).code).toBe(DEVICE_REVOKED)
  })

  it('@core:relay 判定顺序：未配对时先报设备未配对，不泄露通道是否在白名单', async () => {
    relay = await startRelay({ enabled: true, dataDir, pairing })

    // 白名单外的通道：先撞白名单
    const denied = await call('app:change-data-dir', null)
    expect((denied.body.error as { code: string }).code).toBe('CHANNEL_DENIED')

    // 白名单内 + 未配对：报 DEVICE_REVOKED
    const unpaired = await call('session:list', { id: 'unknown', sessionKey: 'x' })
    expect((unpaired.body.error as { code: string }).code).toBe(DEVICE_REVOKED)
  })

  it('@core:relay 不传 pairing 且未声明 allowUnauthenticated 时拒绝启动（PAIRING_REQUIRED）', async () => {
    // 这是 B3 堵住的漏洞：初版 applyRelaySettings 忘了传 pairing，
    // 而 startRelay 会静默退化为「无鉴权」。现在必须显式声明才允许裸奔。
    await expect(startRelay({ enabled: true, dataDir })).rejects.toMatchObject({ code: 'PAIRING_REQUIRED' })
  })

  it('@core:relay 显式声明 allowUnauthenticated 后允许无鉴权（仅测试用）', async () => {
    relay = await startRelay({ enabled: true, dataDir, allowUnauthenticated: true })
    const r = await call('session:list', null)
    expect(r.status).toBe(200)
  })
})

describe('伪装与重放必须被挡住（初版真的漏了）', () => {
  it('@core:relay 只知道 deviceId、没有 sessionKey 的冒充会被拒', async () => {
    const phone = pairDevice()
    relay = await startRelay({ enabled: true, dataDir, pairing })

    // 真机可用
    expect((await call('session:list', phone)).status).toBe(200)

    // 攻击者知道 deviceId，但拿不到 sessionKey → 自己编一个签名
    const forged = { id: phone.id, sessionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
    const attack = await call('session:list', forged)
    expect(attack.status).toBe(403)
  })

  it('@core:relay 只带 deviceId 头、不带签名 → 拒绝', async () => {
    const phone = pairDevice()
    relay = await startRelay({ enabled: true, dataDir, pairing })
    const r = await call('session:list', phone, {}, { noSig: true })
    expect(r.status).toBe(403)
  })

  it('@core:relay 签名被篡改 → 拒绝', async () => {
    const phone = pairDevice()
    relay = await startRelay({ enabled: true, dataDir, pairing })
    const r = await call('session:list', phone, {}, { tamper: 'sig' })
    expect(r.status).toBe(403)
  })

  it('@core:relay 签名绑定通道：拿 A 通道的签名去调 B 通道 → 拒绝', async () => {
    const phone = pairDevice()
    relay = await startRelay({ enabled: true, dataDir, pairing })
    // 用 'other:channel' 签的名，实际请求 'session:list'
    const r = await call('session:list', phone, {}, { tamper: 'channel' })
    expect(r.status).toBe(403)
  })

  it('@core:relay 时间戳超出窗口（重放旧请求）→ 拒绝', async () => {
    const phone = pairDevice()
    relay = await startRelay({ enabled: true, dataDir, pairing })
    const r = await call('session:list', phone, {}, { tamper: 'ts' })
    expect(r.status).toBe(403)
  })

  it('@core:relay 时钟窗口内的时间戳可用（允许几秒漂移）', async () => {
    const phone = pairDevice()
    relay = await startRelay({ enabled: true, dataDir, pairing })
    clock += 30_000 // 30 秒后，仍在 60 秒窗口内
    const r = await call('session:list', phone)
    expect(r.status).toBe(200)
  })
})

describe('配对拒绝要留审计', () => {
  it('@core:relay 未配对请求写入 denied 审计，含错误码', async () => {
    relay = await startRelay({ enabled: true, dataDir, pairing })
    await call('session:list', { id: 'intruder', sessionKey: 'x' })

    const log = readAudit(auditPathIn(dataDir))
    const denied = log.find((e) => e.outcome === 'denied' && e.code === DEVICE_REVOKED)
    expect(denied).toBeTruthy()
    expect(denied?.channel).toBe('session:list')
  })

  it('@core:relay 被撤销设备的请求也留痕', async () => {
    const phone = pairDevice()
    relay = await startRelay({ enabled: true, dataDir, pairing })
    await call('session:list', phone)
    pairing.revokeDevice(phone.id)
    await call('session:list', phone)

    const log = readAudit(auditPathIn(dataDir))
    expect(log.filter((e) => e.code === DEVICE_REVOKED).length).toBeGreaterThanOrEqual(1)
  })

  it('@core:relay 未配对拒绝时审计不含参数原文，也不含签名', async () => {
    relay = await startRelay({ enabled: true, dataDir, pairing })
    await call('session:list', { id: 'intruder', sessionKey: 'x' }, { prompt: 'SECRET-PAYLOAD-XYZ' })

    const raw = readFileSync(auditPathIn(dataDir), 'utf8')
    expect(raw).not.toContain('SECRET-PAYLOAD-XYZ')
    expect(raw).not.toContain('x-morrow-signature')
  })
})