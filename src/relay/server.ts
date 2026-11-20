import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { appendAudit, auditPathIn, describeShape } from './audit'
import { allowedChannels, checkChannel, checkPayload } from './allowlist'
import { boundChannels, dispatch, unboundAllowed } from './registry'
import { DEVICE_REVOKED, type PairingService } from './pairing'

/**
 * Relay 本机 HTTP 服务。
 *
 * 蓝图 B1 的四条验收：
 * 1. **开关关闭时端口不监听**（netstat 验证）；
 * 2. 开启后只接受白名单通道，非白名单返回 CHANNEL_DENIED；
 * 3. 每次调用写 relay/audit.jsonl，不含参数原文；
 * 4. 默认关闭，需用户在设置里显式开启。
 *
 * 三个刻意的设计约束：
 *
 * **只监听回环地址。** `127.0.0.1` 而不是 `0.0.0.0`。监听 0.0.0.0 意味着同网段的
 * 任何人都能访问，而这条通道要调用的是「发指令、批权限」这种能力 —— 等于把电脑交出去。
 * 手机是通过 B3 的 WSS 中继接入的，不需要直连这个回环端口。
 *
 * **端口默认 0（由系统分配）。** 固定端口会和用户机器上任何服务撞车，
 * 且写死端口等于把攻击面固化。实际端口在启动后读回，交给上层告诉中继。
 *
 * **不在 HTTP 层做鉴权。** 鉴权属于 B2（配对与密钥协商）的职责，
 * 这个服务只跑在回环上、且必须显式开启。把鉴权塞进这里会造成两套并存的鉴权逻辑，
 * 反而更容易出错。这里只做「白名单 + 审计」两件事。
 */

export interface RelayConfig {
  /** 用户是否在设置里显式开启（默认 false） */
  enabled: boolean
  /** 数据目录，审计日志写在其下的 relay/audit.jsonl */
  dataDir: string
  /** 监听端口，0 = 由系统分配 */
  port?: number
  /** 监听地址，默认回环 */
  host?: string
  /**
   * 配对服务。**生产环境必须传** —— 不传即拒绝启动（见 startRelay 里的
   * PAIRING_REQUIRED 检查），除非显式设 allowUnauthenticated。
   */
  pairing?: PairingService
  /**
   * 是否允许无鉴权模式。默认 false。
   *
   * 只给测试用（B1 的 netstat 验收需要验证「白名单/审计」本身，而不涉及配对）。
   * 做成显式开关而不是「不传 pairing 就自动降级」：
   * 后者会让生产代码忘记传 pairing 时静默裸奔，这正是 B2 初版的真实缺陷。
   */
  allowUnauthenticated?: boolean
}

export interface RelayHandle {
  /** 实际监听端口；未启动时为 null */
  port: number | null
  /** 是否正在监听 */
  listening: boolean
  /** 停止服务 */
  stop: () => Promise<void>
}

/** 请求体上限：白名单通道的 payload 都是小对象，2MB 足够且能挡住误发大文件 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体超过 2MB 上限'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' }))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // 明确禁止缓存：这些响应里可能含会话内容
    'cache-control': 'no-store'
  })
  res.end(text)
}

/**
 * 启动 relay。**enabled=false 时直接返回未启动的句柄，连 socket 都不会创建。**
 *
 * 这是「开关关闭时端口不监听」的实现方式：不是先启动再拒绝请求，
 * 而是根本不创建服务器。后者能通过 netstat 检查，前者不能 —— 端口仍然在。
 */
export async function startRelay(config: RelayConfig): Promise<RelayHandle> {
  const auditPath = auditPathIn(config.dataDir)
  // 解构出来供请求处理闭包使用
  const pairing = config.pairing

  // ── 强制配对：不传 pairing 就拒绝启动 ──
  // 这是 B2 报告 §7 第 1 条限制的修复。初版让 pairing 可选、不传就退化为
  // 「仅回环无鉴权」，而 applyRelaySettings 恰好没传 —— 生产环境等于没有鉴权。
  //
  // 修法不是简单地 throw（B1 的 netstat 验收需要无鉴权模式），而是要求
  // **显式声明** allowUnauthenticated: true。默认必须传 pairing，
  // 想让通道裸奔必须写出来，写出来就会在 review 时被看到。
  if (!pairing && config.allowUnauthenticated !== true) {
    throw Object.assign(
      new Error('relay 拒绝启动：未提供 pairing。若确实需要无鉴权模式（仅测试），请显式传 allowUnauthenticated: true'),
      { code: 'PAIRING_REQUIRED' }
    )
  }

  if (!config.enabled) {
    return { port: null, listening: false, stop: async () => undefined }
  }

  const unbound = unboundAllowed(allowedChannels())
  if (unbound.length > 0) {
    // 不阻断启动：白名单里允许但暂未接实现的通道会在调用时返回 NOT_BOUND。
    // 但必须留下痕迹，避免「以为通了其实没通」。
    appendAudit(auditPath, {
      at: new Date().toISOString(),
      channel: '$startup',
      outcome: 'ok',
      ms: 0,
      shape: { unbound: `array(${unbound.length})`, bound: `array(${boundChannels().length})` }
    })
  }

  const server: Server = createServer(async (req, res) => {
    const started = Date.now()
    // 路由约定：POST /relay/<通道名>
    const match = /^\/relay\/([^/?]+)$/.exec(req.url ?? '')
    if (!match) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知路由' } })
      return
    }
    const channel = decodeURIComponent(match[1])

    // ── 第一道：白名单 ──
    const decision = checkChannel(channel)
    if (!decision.allowed) {
      appendAudit(auditPath, {
        at: new Date().toISOString(),
        channel,
        outcome: 'denied',
        code: 'CHANNEL_DENIED',
        ms: Date.now() - started
      })
      sendJson(res, 403, decision.result)
      return
    }

    // ── 第二道：配对与请求签名 ──
    // 顺序刻意放在「读参数」之前：未配对设备不该有机会提交 payload，
    // 也不该通过错误信息差异探测通道行为。
    //
    // 必须验证签名，不能只看设备头：明文头等于没有鉴权，
    // 知道 deviceId 就能冒充（初版实现就是这个问题）。
    if (pairing) {
      const header = (name: string): string => {
        const raw = req.headers[name]
        return typeof raw === 'string' ? raw : ''
      }
      const id = header('x-morrow-device')
      const ts = header('x-morrow-timestamp')
      const sig = header('x-morrow-signature')
      try {
        pairing.verifyRequest(id, channel, ts, sig)
      } catch (err) {
        const code = (err as { code?: string })?.code ?? DEVICE_REVOKED
        appendAudit(auditPath, {
          at: new Date().toISOString(),
          channel,
          outcome: 'denied',
          code,
          ms: Date.now() - started,
          // 记录拒绝原因（不含签名本身），便于排查「是没配对还是签名错」
          shape: { reason: `string(${String((err as Error).message).length})` }
        })
        sendJson(res, 403, { ok: false, error: { code, message: (err as Error).message } })
        return
      }
    }

    // ── 第三道：读取参数（大小与 JSON 合法性） ──
    let payload: unknown
    try {
      payload = await readBody(req)
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'BAD_REQUEST'
      appendAudit(auditPath, {
        at: new Date().toISOString(),
        channel,
        outcome: 'error',
        code,
        ms: Date.now() - started
      })
      sendJson(res, 400, { ok: false, error: { code, message: (err as Error).message } })
      return
    }

    // ── 第四道：通道级参数校验 ──
    // 「放行通道」不等于「参数随便传」：open-external 限 scheme、
    // 创作台限 read/preview。这一步在分发之前，避免把危险参数传进 handler。
    const payloadCheck = checkPayload(channel, payload)
    if (!payloadCheck.ok) {
      appendAudit(auditPath, {
        at: new Date().toISOString(),
        channel,
        outcome: 'denied',
        code: 'PAYLOAD_DENIED',
        ms: Date.now() - started
      })
      sendJson(res, 403, { ok: false, error: { code: 'PAYLOAD_DENIED', message: payloadCheck.message } })
      return
    }

    // ── 第五道：分发 ──
    const result = await dispatch(channel, payload)
    appendAudit(auditPath, {
      at: new Date().toISOString(),
      channel,
      outcome: result.ok ? 'ok' : 'error',
      ...(result.error ? { code: result.error.code } : {}),
      ms: Date.now() - started,
      shape: describeShape(payload)
    })
    sendJson(res, result.ok ? 200 : 500, result)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port ?? 0, config.host ?? '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo
  return {
    port: address.port,
    listening: true,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}