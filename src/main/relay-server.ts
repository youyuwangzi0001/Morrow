import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DEVICE_REVOKED, type PairingService } from './relay-pairing'

// ───── src/relay/registry.ts ─────
/**
 * Relay 通道分发表。
 *
 * 桌面侧的 IPC handler 都是直接在 `registerIpcHandlers()` 里挂到 `ipcMain` 上的，
 * 没有留下「按通道名调用」的入口。relay 需要这样一个入口，但**不能**为了它把
 * 现有 100 多个 handler 全部重构成注册表 —— 那是在改一整套稳定代码的架构，
 * 风险远大于收益，而且违背最小改动原则。
 *
 * 所以这里的做法是：relay 自己持有一张「通道 → 处理函数」表，
 * 由应用启动时**显式注入**那些需要远程可达的能力。
 * 没被注入的通道，即使写进白名单也会返回 NOT_BOUND —— 白名单与实现双重约束。
 *
 * 这两层是刻意的：
 * - 白名单管「允许哪些通道」；
 * - 绑定表管「这次运行里哪些能力真的可用」。
 * 少任何一层，都会出现「以为禁用了、实际还能调」的情况。
 */

export type RelayHandler = (payload: unknown) => Promise<unknown>

/** 统一结果形状，与桌面 IPC 的 Result 保持一致，手机端不用区分两套协议 */
export interface RelayResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string; hint?: string }
}

const bound = new Map<string, RelayHandler>()

/** 绑定一个通道的实现。重复绑定直接抛错，避免后绑的悄悄覆盖前一个。 */
export function bindChannel(channel: string, handler: RelayHandler): void {
  if (bound.has(channel)) throw new Error(`relay 通道重复绑定：${channel}`)
  bound.set(channel, handler)
}

/** 测试用：清空绑定 */
export function resetBindings(): void {
  bound.clear()
}

/** 当前已绑定的通道（供启动自检：白名单里哪些还没接实现） */
export function boundChannels(): readonly string[] {
  return [...bound.keys()]
}

/**
 * 白名单里有、但当前运行没绑定实现的通道。
 * 启动时打一条日志，避免「白名单写了 18 条、实际只通 3 条」这种沉默的缺口。
 */
export function unboundAllowed(allowed: readonly string[]): readonly string[] {
  return allowed.filter((c) => !bound.has(c))
}

/**
 * 把请求路由到已绑定的处理函数。
 *
 * 约定：处理函数抛错即视为失败，由调用方（server）统一翻译成 RelayResult，
 * 这样审计日志能拿到错误码，而手机端只会看到结构化错误，不会看到堆栈。
 */
export async function dispatch(channel: string, payload: unknown): Promise<RelayResult> {
  const handler = bound.get(channel)
  if (!handler) {
    return {
      ok: false,
      error: { code: 'NOT_BOUND', message: `通道未绑定实现：${channel}` }
    }
  }
  try {
    const data = await handler(payload)
    return { ok: true, data }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = (err as { code?: string })?.code ?? 'RELAY_ERROR'
    return { ok: false, error: { code, message } }
  }
}

// ───── src/relay/allowlist.ts ─────
/**
 * Relay 通道白名单。
 *
 * 这是整条远程通道的**信任边界**：手机端能做什么，完全由这张表决定。
 * 蓝图 B1 要求「对外只监听白名单；非白名单返回 CHANNEL_DENIED」，并且
 * 「默认关闭，需用户在设置里显式开启」。
 *
 * 三条设计原则（每条都能解释为什么某条通道不在表里）：
 *
 * 1. **只放「看 + 决策」，不放「改环境」**。
 *    手机能发指令、能审批、能停止，但不能改模型 Key、不能改数据目录、不能开外部程序。
 *
 * 2. **不放任何涉及本机执行面或凭据的通道**。
 *    `app:open-external`、`app:change-data-dir`、`app:reset-data-dir`、`settings:save-provider`
 *    这些一旦被远程调用，等于把桌面机器的控制权交出去。
 *
 * 3. **只放只读或幂等的通道，写操作必须是「用户意图明确」的那几个**。
 *    例如 `session:delete`、`session:clear-all` 不放 —— 手机上误触一次就毁掉会话历史，
 *    这类操作必须回到桌面上做。
 */

/** 白名单条目：通道 + 放行理由（理由不是注释摆设，会进审计日志的静态元数据） */
interface AllowEntry {
  readonly channel: string
  readonly why: string
}

/**
 * 逐条白名单。按用途分五组，与蓝图「五个页面」的职责一一对应：
 * 工位（看状态）、对话（发指令）、成员（干预）、审批（决策）、作品（审阅）。
 */
const ENTRIES: readonly AllowEntry[] = [
  // ── 启动与状态：手机冷启动后第一件事就是取全量快照 ──
  { channel: 'app:bootstrap', why: '冷启动取全量状态，工位页首屏依赖它' },

  // ── 会话：只放「读 + 发消息 + 停止」，不放删除/清空/改模型 ──
  { channel: 'session:list', why: '工位页会话列表（只读）' },
  { channel: 'session:load', why: '对话页加载单个会话（只读）' },
  { channel: 'session:rename', why: '会话重命名：可从标题识别，误操作可改回' },

  // ── 对话：发指令与打断，是手机端存在的理由 ──
  { channel: 'chat:send', why: '手机发新指令（核心能力）' },
  { channel: 'chat:cancel', why: '停止正在运行的回合，避免失控消耗' },
  { channel: 'chat:regenerate', why: '重新生成上一条回答（蓝图白名单原文）' },

  // ── 审批与提问：手机端最重要的决策入口 ──
  { channel: 'permission:respond', why: '审批通过/拒绝（蓝图称手机端最重要功能）' },
  { channel: 'question:respond', why: '回答 Agent 的提问，否则任务会一直等' },

  // ── 成员协作：跟盯协作任务，可干预但不重配 ──
  { channel: 'collaboration:projection', why: '成员卡与总目标卡的数据来源（只读）' },
  { channel: 'collaboration:send-message', why: '给某个成员补充要求，继续跑' },
  { channel: 'collaboration:stop-task', why: '停掉某个跑偏的任务' },
  { channel: 'collaboration:retry-task', why: '重试失败任务' },
  { channel: 'collaboration:reactivate', why: '重新激活已结束的成员（蓝图白名单中风险写）' },

  // ── 作品：只读与导出，不做剪辑 ──
  { channel: 'artifact:read', why: '作品页读成品内容（只读）' },
  { channel: 'artifact:versions', why: '版本列表（只读）' },
  { channel: 'artifact:export', why: '导出工程包：蓝图 J3 旅程明确要求' },

  // ── 计划：手机上可以批准/打回计划，但不能改执行模式 ──
  { channel: 'plan:approve', why: '批准执行计划：手机上可做这个决策' },
  { channel: 'plan:reject', why: '打回计划并说明原因，避免桌面空等' },
  { channel: 'plan:revise', why: '要求修改计划（蓝图白名单低风险写）' },
  { channel: 'goal:pause', why: '暂停长任务，避免无人看管时持续消耗' },
  { channel: 'goal:resume', why: '恢复被暂停的任务' },
  { channel: 'goal:stop', why: '终止长任务，停止消耗' },
  { channel: 'session:create', why: '手机上新建会话（蓝图低风险写，无需审批）' },
  { channel: 'session:set-mode', why: '切换会话模式（蓝图低风险写）' },
  { channel: 'session:set-permission-mode', why: '切换权限档位（蓝图列低风险写；每次执行仍需桌面审批）' },
  { channel: 'feature:studio:action', why: '创作台只读子集：payload.type 仅允许 read / preview（蓝图原文限制）' },
  // ── 桌面跳转：暂不放行（见下方说明） ──
  // 蓝图要求 app:open-external「限深链 scheme，只能唤起桌面，不能唤起浏览器」。
  // 但核对了桌面真实实现（src/main/ipc.ts:413）：它只接受 http(s) 并用系统浏览器打开，
  // 全仓也没有 morrow: 深链处理器。
  //
  // 也就是说，现在放行它 = 给手机一个「让桌面开浏览器」的通道，正是蓝图明令禁止的。
  // 所以先不放行，等桌面侧实现 morrow: 深链后再启用；
  // checkPayload() 里的深链校验已经写好了（见 ALLOWED_EXTERNAL_SCHEMES），届时直接生效。
]

/** 允许远程调用的深链 scheme（蓝图：「只能唤起桌面，不能唤起浏览器」） */
const ALLOWED_EXTERNAL_SCHEMES = ['morrow:']

/**
 * 通道级参数校验：部分通道「放行」不等于「参数随便传」。
 *
 * 蓝图对两个通道有明确的子集限制，这里做成校验而不是只写注释 ——
 * 注释不会阻止攻击，校验会。
 *
 * - `app:open-external`：只允许 morrow: 深链。不限的话这就是个
 *   「让桌面打开任意 URL / 本地文件」的通道。
 * - `feature:studio:action`：只允许 read / preview。创作台的 action 里
 *   还有写操作，全放行等于把创作台交出去。
 */
export function checkPayload(channel: string, payload: unknown): { ok: true } | { ok: false; message: string } {
  const p = (payload ?? {}) as Record<string, unknown>

  if (channel === 'app:open-external') {
    const url = typeof p.url === 'string' ? p.url : ''
    if (!url) return { ok: false, message: 'app:open-external 需要 url' }

    // 控制字符必须先拒绝。
    // 只校验 scheme 前缀会被换行/null 注入绕过：
    //   "morrow://x\nhttps://evil.com"、"morrow://x\0https://evil.com"
    // 这两种输入的前缀都是合法的 morrow:，但下游若按行或按 null 截断解析，
    // 就可能打开后半截那个恶意地址。审查探针实测这两种都被放行过。
    if (/[\u0000-\u001f\u007f]/.test(url)) {
      return { ok: false, message: 'app:open-external 的 url 不允许包含控制字符' }
    }

    const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase()
    if (!ALLOWED_EXTERNAL_SCHEMES.includes(scheme)) {
      return { ok: false, message: `app:open-external 只允许 ${ALLOWED_EXTERNAL_SCHEMES.join('/')} 深链` }
    }
    // 长度上限：深链带参数也不会超过这个数，超长输入更像攻击而非正常使用
    if (url.length > 2048) {
      return { ok: false, message: 'app:open-external 的 url 过长' }
    }
    return { ok: true }
  }

  if (channel === 'feature:studio:action') {
    const type = typeof p.type === 'string' ? p.type : ''
    if (type !== 'read' && type !== 'preview') {
      return { ok: false, message: '创作台只允许 read / preview 两种 type' }
    }
    return { ok: true }
  }

  return { ok: true }
}

/** 白名单集合，供 O(1) 判定 */
const ALLOWED = new Map<string, string>(ENTRIES.map((e) => [e.channel, e.why]))

/** 非白名单通道统一返回的错误码（蓝图原文要求） */
export const CHANNEL_DENIED = 'CHANNEL_DENIED'

export interface DeniedResult {
  ok: false
  error: { code: typeof CHANNEL_DENIED; message: string }
}

export type AllowDecision = { allowed: true; why: string } | { allowed: false; result: DeniedResult }

/**
 * 判定一个通道是否放行。
 *
 * 注意判定的严格性：
 * - 只做**精确匹配**，不做前缀匹配。`session:*` 这种通配会让新增通道自动获得授权，
 *   等于白名单失效 —— 这正是这类设计最常见的漏洞。
 * - 空/非字符串一律拒绝，不给「undefined 恰好能通过」留缝隙。
 */
export function checkChannel(channel: unknown): AllowDecision {
  if (typeof channel !== 'string' || channel.length === 0) {
    return {
      allowed: false,
      result: {
        ok: false,
        error: { code: CHANNEL_DENIED, message: '通道名必须是非空字符串' }
      }
    }
  }
  const why = ALLOWED.get(channel)
  if (why === undefined) {
    return {
      allowed: false,
      result: {
        ok: false,
        error: { code: CHANNEL_DENIED, message: `非白名单通道：${channel}` }
      }
    }
  }
  return { allowed: true, why }
}

/** 列出全部白名单通道（供设置页展示与测试比对） */
export function allowedChannels(): readonly string[] {
  return ENTRIES.map((e) => e.channel)
}

/** 供测试断言「白名单里没有危险通道」 */
export function allowReason(channel: string): string | undefined {
  return ALLOWED.get(channel)
}

// ───── src/relay/audit.ts ─────
/**
 * Relay 审计日志。
 *
 * 蓝图 B1 验收原文：「每次调用写 relay/audit.jsonl，**不含参数原文**」。
 *
 * 「不含参数原文」是最容易被做成假实现的一条：看起来写了日志，实际把 `payload`
 * 整个 JSON.stringify 进去，于是用户的工作区路径、提示词、甚至密钥片段全都落盘。
 * 这不是审计，是泄密。
 *
 * 所以这里只记**结构性信息**：
 * - 通道名（白名单内的固定字符串，安全）
 * - 结果状态（ok / denied / error + 错误码）
 * - 参数的结构指纹（键名列表 + 各键的类型与长度），可用来排查「为什么这次调用失败」
 * - 时间与耗时
 *
 * 键名本身可能包含用户输入吗？不会 —— 键名来自调用方构造的 payload schema，
 * 是固定字段（如 `sessionId`、`prompt`），值才可能敏感。所以键名可以记，值一律不记。
 */

export interface AuditEntry {
  /** ISO 时间戳 */
  at: string
  /** IPC 通道名 */
  channel: string
  /** 结果分类 */
  outcome: 'ok' | 'denied' | 'error'
  /** 错误码（outcome 非 ok 时存在） */
  code?: string
  /** 耗时（毫秒） */
  ms: number
  /** 参数结构指纹：键名 → 类型/长度，不含值 */
  shape?: Record<string, string>
}

/**
 * 提取参数的结构指纹，绝不包含值本身。
 *
 * 例：`{ sessionId: 'abc-123', limit: 20 }`
 * → `{ sessionId: 'string(7)', limit: 'number' }`
 */
export function describeShape(payload: unknown, maxKeys = 12): Record<string, string> | undefined {
  if (payload === null || payload === undefined) return undefined
  if (typeof payload !== 'object') return { $self: typeof payload }
  if (Array.isArray(payload)) return { $self: `array(${payload.length})` }

  const out: Record<string, string> = {}
  const keys = Object.keys(payload as Record<string, unknown>)
  for (const key of keys.slice(0, maxKeys)) {
    const v = (payload as Record<string, unknown>)[key]
    if (v === null) out[key] = 'null'
    else if (Array.isArray(v)) out[key] = `array(${v.length})`
    else if (typeof v === 'string') out[key] = `string(${v.length})`
    else if (typeof v === 'object') out[key] = 'object'
    else out[key] = typeof v
  }
  // 键太多时留个计数，说明被截断了（不记多余键名，避免把用户自定义键写进日志）
  if (keys.length > maxKeys) out.$more = `${keys.length - maxKeys}`
  return out
}

/**
 * 追加一条审计记录。
 *
 * 用 `appendFileSync` 而不是异步写：审计的价值在于「即使进程随后崩了，这条记录也在」。
 * 异步写在崩溃场景下会丢，正是最需要它的时候没有。
 */
export function appendAudit(auditPath: string, entry: AuditEntry): void {
  const dir = dirname(auditPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf8')
}

/** 读取审计日志（供测试与设置页「查看审计」使用） */
export function readAudit(auditPath: string): AuditEntry[] {
  if (!existsSync(auditPath)) return []
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry)
}

/** 默认审计文件位置：<dataDir>/relay/audit.jsonl */
export function auditPathIn(dataDir: string): string {
  return join(dataDir, 'relay', 'audit.jsonl')
}

// ───── src/relay/server.ts ─────
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
