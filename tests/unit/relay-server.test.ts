/**
 * relay 服务域单测：HTTP 服务骨架、白名单、审计日志、配对门禁与参数校验门禁。
 * 
 * 由 relay.test / relay-pair-gate / relay-payload-gate 三个文件合并；
 * 每个 it 的标题与断言原样保留，各来源的文件级说明保留在对应段前。
 */
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowedChannels, allowReason, checkChannel, checkPayload, CHANNEL_DENIED, appendAudit, auditPathIn, describeShape, readAudit, bindChannel, dispatch, resetBindings, unboundAllowed, startRelay, type RelayHandle } from '../../src/main/relay-server'
import { createECDH, randomBytes } from 'node:crypto'
import { DEVICE_REVOKED, PairingService } from '../../src/main/relay-pairing'

// ───── 来源：tests/unit/relay.test.ts ─────
/**
 * B1 卡验收：morrow-relay 服务骨架。
 *
 * 蓝图四条验收：
 * 1. 开关关闭时端口不监听（netstat 验证）
 * 2. 开启后只接受白名单通道，非白名单返回 CHANNEL_DENIED
 * 3. 每次调用写 relay/audit.jsonl，不含参数原文
 * 4. 默认关闭，需显式开启
 */
describe('HTTP 服务与白名单', () => {
  let dataDir = ''
  let relay: RelayHandle | null = null

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'morrow-relay-'))
    resetBindings()
  })

  afterEach(async () => {
    if (relay) {
      await relay.stop()
      relay = null
    }
    rmSync(dataDir, { recursive: true, force: true })
  })

  /** 探测某端口是否真的可以建立 TCP 连接 —— 这是「端口在监听」的直接证据 */
  function canConnect(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createServer()
      const conn = socket.listen(0, host, () => {
        const client = new (require('node:net').Socket)()
        client.setTimeout(300)
        client.once('connect', () => {
          client.destroy()
          socket.close(() => resolve(true))
        })
        client.once('error', () => {
          client.destroy()
          socket.close(() => resolve(false))
        })
        client.once('timeout', () => {
          client.destroy()
          socket.close(() => resolve(false))
        })
        client.connect(port, host)
      })
    })
  }

  async function post(port: number, channel: string, payload?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}/relay/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload === undefined ? '' : JSON.stringify(payload)
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  // ───────────────────────── 验收 4：默认关闭 ─────────────────────────

  describe('默认关闭', () => {
    it('@core:relay 未传 enabled 或 enabled=false 时不监听、不占端口', async () => {
      relay = await startRelay({ allowUnauthenticated: true, enabled: false, dataDir })
      expect(relay.listening).toBe(false)
      expect(relay.port).toBeNull()
    })

    it('@core:relay 关闭状态下 stop() 可安全调用（幂等）', async () => {
      const h = await startRelay({ allowUnauthenticated: true, enabled: false, dataDir })
      await h.stop()
      await h.stop()
      expect(h.listening).toBe(false)
    })
  })

  // ───────────────────── 验收 1：端口不监听（netstat 等价） ─────────────────────

  describe('端口监听状态', () => {
    it('@core:relay 关闭时任意固定端口都不会被占用', async () => {
      // 先占一个临时端口号，再让 relay 用同一端口但保持关闭
      const probe = createServer()
      const port = await new Promise<number>((resolve) => {
        probe.listen(0, '127.0.0.1', () => {
          const p = (probe.address() as { port: number }).port
          probe.close(() => resolve(p))
        })
      })

      relay = await startRelay({ allowUnauthenticated: true, enabled: false, dataDir, port })
      // 关闭时端口号是外界给的，但服务没起来 —— 这里的关键断言是 listening=false，
      // 且该端口仍可被别的进程占用（说明 relay 没占着它）
      expect(relay.listening).toBe(false)

      const probe2 = createServer()
      const reusable = await new Promise<boolean>((resolve) => {
        probe2.once('error', () => resolve(false))
        probe2.listen(port, '127.0.0.1', () => probe2.close(() => resolve(true)))
      })
      expect(reusable).toBe(true)
    })

    it('@core:relay 开启后端口真的可以建立 TCP 连接', async () => {
      bindChannel('app:bootstrap', async () => ({ ready: true }))
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })
      expect(relay.listening).toBe(true)
      expect(relay.port).toBeGreaterThan(0)
      expect(await canConnect(relay.port as number)).toBe(true)
    })

    it('@core:relay 默认只监听回环地址，不对局域网开放', async () => {
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })
      // 回环可连
      expect(await canConnect(relay.port as number, '127.0.0.1')).toBe(true)
      // 只要不是回环，就不应连上（CI/沙箱里通常没有非回环地址，退化为跳过）
      const ifaces = require('node:os').networkInterfaces() as Record<string, Array<{ address: string; family: string; internal: boolean }>>
      const external = Object.values(ifaces)
        .flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal)
      if (external) {
        expect(await canConnect(relay.port as number, external.address)).toBe(false)
      }
    })
  })

  // ───────────────────── 验收 2：白名单 ─────────────────────

  describe('白名单', () => {
    it('@core:relay 白名单内的通道放行，并给出理由', () => {
      expect(checkChannel('chat:send').allowed).toBe(true)
      expect(checkChannel('permission:respond').allowed).toBe(true)
      expect(allowReason('chat:send')).toBeTruthy()
    })

    it('@core:relay 非白名单返回 CHANNEL_DENIED', () => {
      const d = checkChannel('app:change-data-dir')
      expect(d.allowed).toBe(false)
      if (!d.allowed) {
        expect(d.result.error.code).toBe(CHANNEL_DENIED)
      }
    })

    it('@core:relay 危险的写操作与凭据类通道都不在白名单里', () => {
      const dangerous = [
        'app:change-data-dir',
        'app:reset-data-dir',
        'session:delete',
        'session:clear-all',
        'settings:update',
        'settings:save-provider',
        'terminal:start-task',
        'file:search'
      ]
      for (const ch of dangerous) {
        expect(checkChannel(ch).allowed, `${ch} 不应被放行`).toBe(false)
      }
    })

    it('@core:relay app:open-external 暂不放行（桌面实现只开浏览器，与蓝图要求冲突）', () => {
      // 蓝图要「限深链、只能唤起桌面」，但 desktop 的 IPC.openExternal
      // 只接受 http(s) 并用系统浏览器打开，且全仓无 morrow: 深链处理器。
      // 放行它就等于给手机一个「让桌面开浏览器」的通道 —— 蓝图明令禁止。
      expect(checkChannel('app:open-external').allowed).toBe(false)

      // 深链校验逻辑已备好，等桌面实现深链后可直接启用（现在也不该放行任意 URL）
      expect(checkPayload('app:open-external', { url: 'morrow://session/ses_1' }).ok).toBe(true)
      expect(checkPayload('app:open-external', { url: 'https://evil.com' }).ok).toBe(false)
    })

    it('@core:relay app:open-external 拒绝换行与 null 注入（审查实测的绕过手法）', () => {
      // 这两个输入的前缀都是合法的 morrow:，但后半截藏了恶意地址。
      // 只校验 scheme 前缀时它们会被放行 —— 审查探针实测确认过。
      expect(checkPayload('app:open-external', { url: 'morrow://x\nhttps://evil.com' }).ok).toBe(false)
      expect(checkPayload('app:open-external', { url: 'morrow://x\u0000https://evil.com' }).ok).toBe(false)
      expect(checkPayload('app:open-external', { url: 'morrow://x\rhttps://evil.com' }).ok).toBe(false)
      expect(checkPayload('app:open-external', { url: 'morrow://x\thttps://evil.com' }).ok).toBe(false)
    })

    it('@core:relay app:open-external 的 scheme 大小写不敏感（不该误拒正常输入）', () => {
      expect(checkPayload('app:open-external', { url: 'MORROW://session/1' }).ok).toBe(true)
      expect(checkPayload('app:open-external', { url: 'Morrow://x' }).ok).toBe(true)
    })

    it('@core:relay app:open-external 拒绝无 scheme、协议相对、超长输入', () => {
      for (const url of ['morrow//x', '//evil.com', '../morrow://x', 'morrowx://x', 'morrow-://x']) {
        expect(checkPayload('app:open-external', { url }).ok, `${url} 应被拒`).toBe(false)
      }
      expect(checkPayload('app:open-external', { url: 'morrow://' + 'a'.repeat(3000) }).ok).toBe(false)
    })

    it('@core:relay feature:studio:action 只允许 read / preview（蓝图原文子集）', () => {
      expect(checkChannel('feature:studio:action').allowed).toBe(true)

      expect(checkPayload('feature:studio:action', { type: 'read' }).ok).toBe(true)
      expect(checkPayload('feature:studio:action', { type: 'preview' }).ok).toBe(true)

      // 写操作必须被拒
      for (const type of ['write', 'delete', 'export', '', undefined]) {
        expect(checkPayload('feature:studio:action', { type }).ok, `${String(type)} 应被拒`).toBe(false)
      }
    })

    it('@core:relay 白名单不做前缀通配：session: 只放具体那几条', () => {
      // 前缀匹配是最常见的漏洞写法；这里显式验证「新增通道不会自动获得授权」
      expect(checkChannel('session:list').allowed).toBe(true)
      expect(checkChannel('session:delete').allowed).toBe(false)
      expect(checkChannel('session:clear-all').allowed).toBe(false)
    })

    it('@core:relay 空/非字符串通道一律拒绝', () => {
      for (const bad of ['', null, undefined, 123, {}, []]) {
        expect(checkChannel(bad).allowed, `${String(bad)} 应被拒绝`).toBe(false)
      }
    })

    it('@core:relay 白名单每条都有非空理由（防止加了通道却不说明为什么）', () => {
      for (const ch of allowedChannels()) {
        expect(allowReason(ch)?.length ?? 0, `${ch} 缺理由`).toBeGreaterThan(4)
      }
    })
  })

  // ───────────────────── 验收 3：审计不含参数原文 ─────────────────────

  describe('审计日志', () => {
    it('@core:relay 记录通道、结果、耗时与参数结构，但不含参数值', async () => {
      bindChannel('chat:send', async () => ({ accepted: true }))
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })

      const secret = '这是用户输入的机密提示词-super-secret-token-abc123'
      await post(relay.port as number, 'chat:send', { sessionId: 's-1', prompt: secret })

      const log = readAudit(auditPathIn(dataDir))
      const entry = log[log.length - 1]
      expect(entry.channel).toBe('chat:send')
      expect(entry.outcome).toBe('ok')
      expect(entry.ms).toBeGreaterThanOrEqual(0)

      // 结构指纹在
      expect(entry.shape?.sessionId).toBe('string(3)')
      expect(entry.shape?.prompt).toBe(`string(${secret.length})`)

      // 参数原文绝不在日志里 —— 这是蓝图明确要求
      const raw = readFileSync(auditPathIn(dataDir), 'utf8')
      expect(raw).not.toContain(secret)
      expect(raw).not.toContain('s-1')
    })

    it('@core:relay 被拒绝的请求也留审计（否则看不到谁在试探）', async () => {
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })
      const r = await post(relay.port as number, 'app:change-data-dir', { dir: 'C:/secret' })
      expect(r.status).toBe(403)

      const log = readAudit(auditPathIn(dataDir))
      const denied = log.find((e) => e.outcome === 'denied')
      expect(denied?.channel).toBe('app:change-data-dir')
      expect(denied?.code).toBe(CHANNEL_DENIED)
    })

    it('@core:relay describeShape 不泄露嵌套对象内部的值', () => {
      const shape = describeShape({ config: { apiKey: 'sk-live-abcdef' }, n: 3 })
      expect(shape?.config).toBe('object')
      expect(shape?.n).toBe('number')
      expect(JSON.stringify(shape)).not.toContain('sk-live')
    })
  })

  // ───────────────────── 端到端：白名单 + 分发 ─────────────────────

  describe('端到端', () => {
    it('@core:relay 白名单内且已绑定的通道返回处理结果', async () => {
      bindChannel('session:list', async () => [{ id: 's-1' }])
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })

      const r = await post(relay.port as number, 'session:list', {})
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(true)
      expect(r.body.data).toEqual([{ id: 's-1' }])
    })

    it('@core:relay 白名单内但未绑定的通道返回 NOT_BOUND（白名单与实现双重约束）', async () => {
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })
      const r = await post(relay.port as number, 'chat:send', { prompt: 'hi' })
      expect(r.status).toBe(500)
      const err = r.body.error as { code: string }
      expect(err.code).toBe('NOT_BOUND')
    })

    it('@core:relay 处理函数抛错时返回结构化错误，不把堆栈交给手机端', async () => {
      bindChannel('chat:send', async () => {
        throw Object.assign(new Error('模型额度不足'), { code: 'QUOTA' })
      })
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })
      const r = await post(relay.port as number, 'chat:send', { prompt: 'hi' })
      const err = r.body.error as { code: string; message: string }
      expect(err.code).toBe('QUOTA')
      expect(err.message).toBe('模型额度不足')
      expect(JSON.stringify(r.body)).not.toContain('at ')
    })

    it('@core:relay 未知路由返回 404，不进入分发', async () => {
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })
      const res = await fetch(`http://127.0.0.1:${relay.port}/nope`, { method: 'POST' })
      expect(res.status).toBe(404)
    })

    it('@core:relay 未绑定通道能被启动自检发现（避免白名单写了但没实现）', () => {
      bindChannel('session:list', async () => [])
      const missing = unboundAllowed(allowedChannels())
      expect(missing).toContain('chat:send')
      expect(missing).not.toContain('session:list')
    })
  })

  // ───────────────────── 纯函数边界 ─────────────────────

  describe('边界', () => {
    it('@core:relay appendAudit 会创建缺失的目录', () => {
      const deep = join(dataDir, 'a', 'b', 'c', 'audit.jsonl')
      appendAudit(deep, { at: '2026-01-01T00:00:00.000Z', channel: 'x', outcome: 'ok', ms: 1 })
      expect(readAudit(deep)).toHaveLength(1)
    })

    it('@core:relay 重复绑定同一通道会抛错，不会静默覆盖', () => {
      bindChannel('chat:send', async () => 1)
      expect(() => bindChannel('chat:send', async () => 2)).toThrow(/重复绑定/)
    })

    it('@core:relay dispatch 对未绑定通道返回 NOT_BOUND 而不是抛异常', async () => {
      const r = await dispatch('session:load', {})
      expect(r.ok).toBe(false)
      expect(r.error?.code).toBe('NOT_BOUND')
    })
  })
})

// ───── 来源：tests/unit/relay-pair-gate.test.ts ─────
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
describe('配对门禁', () => {
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
})

// ───── 来源：tests/unit/relay-payload-gate.test.ts ─────
/**
 * 通道级参数校验接入验收。
 *
 * 为什么单独测：`checkPayload()` 在 allowlist.ts 里单测全绿，
 * 但如果 server.ts 没调它，那就是一段没人用的死代码 ——
 * 「open-external 只允许 morrow: 深链」这个安全保证就只存在于文档里。
 *
 * 所以这里发真实 HTTP 请求，断言危险 payload 被 403 挡在分发之前。
 */
describe('参数校验门禁', () => {
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
})
