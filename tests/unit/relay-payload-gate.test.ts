import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PairingService } from '../../src/relay/pairing'
import { bindChannel, resetBindings } from '../../src/relay/registry'
import { startRelay, type RelayHandle } from '../../src/relay/server'
import { readAudit, auditPathIn } from '../../src/relay/audit'

/**
 * 通道级参数校验接入验收。
 *
 * 为什么单独测：`checkPayload()` 在 allowlist.ts 里单测全绿，
 * 但如果 server.ts 没调它，那就是一段没人用的死代码 ——
 * 「open-external 只允许 morrow: 深链」这个安全保证就只存在于文档里。
 *
 * 所以这里发真实 HTTP 请求，断言危险 payload 被 403 挡在分发之前。
 */

let dataDir = ''
let relay: RelayHandle | null = null
let pairing: PairingService
let clock = 1_700_000_000_000
let phone: { id: string; sessionKey: string }

function setupPhone() {
  // 用 PairingService 走一遍完整配对，拿到可用的 sessionKey
  const { createECDH } = require('node:crypto') as typeof import('node:crypto')
  const e = createECDH('prime256v1')
  e.generateKeys()
  const pub = e.getPublicKey().toString('base64')
  const { ticket } = pairing.issueTicket('phone-x', pub)
  const dev = pairing.completePairing(ticket.nonce, pub)
  return { id: 'phone-x', sessionKey: dev.sessionKey }
}

beforeEach(() => {
  clock = 1_700_000_000_000
  dataDir = mkdtempSync(join(tmpdir(), 'morrow-payload-'))
  resetBindings()
  pairing = new PairingService({ secret: randomBytes(32), now: () => clock })
  // 绑定两个受限制的通道，用于确认「参数合法时会真的走到 handler」
  bindChannel('app:open-external', async () => ({ opened: true }))
  bindChannel('feature:studio:action', async (p) => ({ handled: (p as { type?: string })?.type }))
  phone = setupPhone()
})

afterEach(async () => {
  if (relay) {
    await relay.stop()
    relay = null
  }
  rmSync(dataDir, { recursive: true, force: true })
})

async function call(channel: string, payload: unknown) {
  const ts = String(clock)
  const sig = PairingService.signRequest(phone.sessionKey, phone.id, channel, ts)

  // 本地套接字在高并发测试下有极小概率出现瞬时连接拒绝：
  // 前一个用例的 relay 刚 close()，端口处于回收态。重试一次即可，
  // 不影响断言的有效性（断言看的是业务响应码，不是连接次数）。
  const send = () =>
    fetch(`http://127.0.0.1:${relay!.port}/relay/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        connection: 'close',
        'x-morrow-device': phone.id,
        'x-morrow-timestamp': ts,
        'x-morrow-signature': sig
      },
      body: JSON.stringify(payload)
    })

  let res: Response
  try {
    res = await send()
  } catch {
    await new Promise((r) => setTimeout(r, 50))
    res = await send()
  }
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('参数校验真的接在请求路径上', () => {
  it('@core:relay studio:action 的写操作 type → 403 PAYLOAD_DENIED', async () => {
    relay = await startRelay({ enabled: true, dataDir, pairing })
    const r = await call('feature:studio:action', { type: 'write' })
    expect(r.status).toBe(403)
    expect((r.body.error as { code: string }).code).toBe('PAYLOAD_DENIED')
  })

  it('@core:relay studio:action 的 read / preview → 放行', async () => {
    relay = await startRelay({ enabled: true, dataDir, pairing })
    for (const type of ['read', 'preview']) {
      const r = await call('feature:studio:action', { type })
      expect(r.status).toBe(200)
      expect(r.body.data).toEqual({ handled: type })
    }
  })

  it('@core:relay open-external 连通道本身都不放行（桌面实现只开浏览器）', async () => {
    relay = await startRelay({ enabled: true, dataDir, pairing })
    // 即使 payload 是合法的 morrow: 深链，也在白名单这一层就被挡住
    const r = await call('app:open-external', { url: 'morrow://session/ses_1' })
    expect(r.status).toBe(403)
    expect((r.body.error as { code: string }).code).toBe('CHANNEL_DENIED')
  })

  it('@core:relay 被参数校验拒绝的请求留审计，码为 PAYLOAD_DENIED', async () => {
    relay = await startRelay({ enabled: true, dataDir, pairing })
    await call('feature:studio:action', { type: 'delete', secret: 'AUDIT-SECRET-XYZ' })

    const log = readAudit(auditPathIn(dataDir))
    const denied = log.find((e) => e.code === 'PAYLOAD_DENIED')
    expect(denied).toBeTruthy()
    expect(denied?.channel).toBe('feature:studio:action')
    // 审计里不该出现 payload 内容
    expect(JSON.stringify(log)).not.toContain('AUDIT-SECRET-XYZ')
  })
})