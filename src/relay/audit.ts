import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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