// P1-10 工作区权限规则持久化 + 审批日志。
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { extractDocumentPath } from '../../core/permissions'
import type {
  PermissionDecision,
  PermissionLogEntry,
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleKind
} from '../../shared/types'
import { log } from './logger'

const FILE_VERSION = 1
const MAX_RULES = 300
const MAX_LOG_BYTES = 1024 * 1024
const MAX_LOG_ENTRIES = 100
const VALID_KINDS: ReadonlySet<PermissionRuleKind> = new Set(['tool', 'prefix', 'path'])
const PREFIX_TOOLS = new Set(['run_command', 'terminal'])
const PATH_TOOLS = new Set(['write_file', 'edit_file', 'write_xlsx', 'edit_docx'])

interface RulesFile {
  version: number
  rules: PermissionRule[]
}

let runtimeDataDir: string | null = null

export function configurePermissionRulesRuntime(dataDir: string | null): void {
  runtimeDataDir = dataDir && dataDir.trim() ? resolve(dataDir) : null
}

function dataDirOf(explicit?: string): string {
  if (explicit && explicit.trim()) return resolve(explicit)
  if (runtimeDataDir) return runtimeDataDir
  const env = process.env.MORROW_DATA_DIR
  if (env && env.trim()) return resolve(env)
  throw new Error('权限规则数据目录未配置')
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
    }
    throw err
  }
}

/** 规则与运行时都使用真实路径，避免 junction/符号链接导致规则「写了却不生效」。 */
function canonicalWorkspace(workspace: string): string {
  const trimmed = workspace.trim()
  if (!trimmed) return ''
  const resolved = resolve(trimmed)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function workspaceKey(workspace: string): string {
  const canonical = canonicalWorkspace(workspace)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function normalizeWorkspace(workspace: string): string {
  const normalized = canonicalWorkspace(workspace)
  if (!normalized) throw new Error('缺少工作区路径。')
  return normalized
}

function isRule(value: unknown): value is PermissionRule {
  if (!value || typeof value !== 'object') return false
  const rule = value as Record<string, unknown>
  return (
    typeof rule.id === 'string' &&
    typeof rule.workspace === 'string' &&
    typeof rule.tool === 'string' &&
    typeof rule.kind === 'string' &&
    VALID_KINDS.has(rule.kind as PermissionRuleKind) &&
    typeof rule.pattern === 'string' &&
    (rule.decision === 'allow' || rule.decision === 'deny') &&
    typeof rule.createdAt === 'number'
  )
}

export class PermissionRulesService {
  constructor(private readonly dataDir: string) {}

  private rulesPath(): string {
    return join(this.dataDir, 'permissions.json')
  }

  private logPath(): string {
    return join(this.dataDir, 'permissions', 'approval-log.jsonl')
  }

  private load(): RulesFile {
    const file = this.rulesPath()
    if (!existsSync(file)) return { version: FILE_VERSION, rules: [] }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const rules = Array.isArray(raw.rules)
        ? raw.rules.filter(isRule).map((rule) => ({ ...rule, workspace: canonicalWorkspace(rule.workspace) }))
        : []
      return { version: FILE_VERSION, rules }
    } catch (err) {
      log.warn('permissions parse failed', { error: String(err) })
      // 保留损坏文件，避免下一次保存把用户规则静默覆盖成空列表
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`)
      } catch {
        // 备份失败时仍以空规则继续，写盘会走原子替换
      }
      return { version: FILE_VERSION, rules: [] }
    }
  }

  private save(file: RulesFile): void {
    atomicWrite(this.rulesPath(), JSON.stringify({ version: FILE_VERSION, rules: file.rules }, null, 2))
  }

  list(workspace: string): PermissionRule[] {
    const key = workspaceKey(workspace)
    return this.load()
      .rules.filter((rule) => workspaceKey(rule.workspace) === key)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  add(input: {
    workspace: string
    tool: string
    kind: PermissionRuleKind
    pattern: string
    decision: PermissionRuleDecision
  }): PermissionRule {
    const workspace = normalizeWorkspace(input.workspace)
    const key = workspaceKey(workspace)
    const tool = input.tool.trim()
    if (!tool || tool.length > 80) throw new Error('工具名不能为空且不能超过 80 字符。')
    if (!VALID_KINDS.has(input.kind)) throw new Error('规则类型不合法。')
    if (input.kind === 'prefix' && !PREFIX_TOOLS.has(tool)) {
      throw new Error('命令前缀规则只适用于 run_command / terminal。')
    }
    if (input.kind === 'path' && !PATH_TOOLS.has(tool)) {
      throw new Error('路径规则只适用于写文件类工具。')
    }
    // 整个工具规则不需要匹配内容；前缀规则折叠空白后再比较，避免「npm  test」与「npm test」重复
    const pattern =
      input.kind === 'tool'
        ? ''
        : input.kind === 'prefix'
          ? input.pattern.replace(/\s+/g, ' ').trim()
          : input.pattern.trim()
    if (input.kind !== 'tool' && !pattern) throw new Error('规则内容不能为空且不能超过 500 字符。')
    if (pattern.length > 500) throw new Error('规则内容不能为空且不能超过 500 字符。')
    if (input.decision !== 'allow' && input.decision !== 'deny') throw new Error('规则动作不合法。')
    const file = this.load()
    const duplicate = file.rules.find(
      (rule) =>
        workspaceKey(rule.workspace) === key &&
        rule.tool === tool &&
        rule.kind === input.kind &&
        rule.pattern === pattern &&
        rule.decision === input.decision
    )
    if (duplicate) return duplicate
    if (file.rules.filter((rule) => workspaceKey(rule.workspace) === key).length >= MAX_RULES) {
      throw new Error(`每个工作区最多 ${MAX_RULES} 条权限规则。`)
    }
    const rule: PermissionRule = {
      id: `rule_${randomUUID().slice(0, 12)}`,
      workspace,
      tool,
      kind: input.kind,
      pattern,
      decision: input.decision,
      createdAt: Date.now()
    }
    file.rules.push(rule)
    this.save(file)
    return rule
  }

  remove(id: string, workspace?: string): boolean {
    const key = workspace ? workspaceKey(workspace) : null
    const file = this.load()
    const before = file.rules.length
    file.rules = file.rules.filter((rule) => {
      if (rule.id !== id) return true
      return key !== null && workspaceKey(rule.workspace) !== key
    })
    if (file.rules.length === before) return false
    this.save(file)
    return true
  }

  /** 「始终允许」→ 持久规则（只对可安全泛化的工具生成）。 */
  addAlwaysRule(input: {
    workspace: string | null
    tool: string
    toolInput: Record<string, unknown>
  }): PermissionRule | null {
    if (!input.workspace) return null
    try {
      if (input.tool === 'run_command' || input.tool === 'terminal') {
        const command = typeof input.toolInput.command === 'string' ? input.toolInput.command.trim() : ''
        if (!command) return null
        return this.add({
          workspace: input.workspace,
          tool: input.tool,
          kind: 'prefix',
          pattern: command.replace(/\s+/g, ' '),
          decision: 'allow'
        })
      }
      if (PATH_TOOLS.has(input.tool)) {
        // 与 permissionRuleMatches 共用同一路径优先级（edit_docx 以 output_path 为准）
        const raw = extractDocumentPath(input.tool, input.toolInput)
        if (!raw) return null
        return this.add({ workspace: input.workspace, tool: input.tool, kind: 'path', pattern: raw, decision: 'allow' })
      }
      return null
    } catch (err) {
      log.warn('persist always-allow rule failed', { tool: input.tool, error: String(err) })
      return null
    }
  }

  /** 清除全部对话时移除审批历史；用户配置的权限规则保留。 */
  clearLog(): void {
    try {
      rmSync(this.logPath(), { force: true })
    } catch (err) {
      log.warn('approval log cleanup failed', { error: String(err) })
    }
  }

  appendLog(entry: Omit<PermissionLogEntry, 'id'>): void {
    try {
      const file = this.logPath()
      mkdirSync(dirname(file), { recursive: true })
      if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
        const lines = readFileSync(file, 'utf8').trim().split('\n').slice(-MAX_LOG_ENTRIES * 2)
        atomicWrite(file, `${lines.join('\n')}\n`)
      }
      const item: PermissionLogEntry = { ...entry, id: `log_${randomUUID().slice(0, 10)}` }
      writeFileSync(file, `${JSON.stringify(item)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' })
    } catch (err) {
      log.warn('approval log append failed', { error: String(err) })
    }
  }

  listLog(workspace?: string | null): PermissionLogEntry[] {
    try {
      const file = this.logPath()
      if (!existsSync(file)) return []
      const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-MAX_LOG_ENTRIES * 2)
      const key = workspace ? workspaceKey(workspace) : null
      const entries: PermissionLogEntry[] = []
      for (const line of lines) {
        try {
          const item = JSON.parse(line) as PermissionLogEntry
          if (typeof item.at !== 'number' || typeof item.toolName !== 'string') continue
          if (key && item.workspace && workspaceKey(item.workspace) !== key) continue
          entries.push(item)
        } catch {
          // 跳过损坏行
        }
      }
      return entries.sort((a, b) => b.at - a.at).slice(0, MAX_LOG_ENTRIES)
    } catch {
      return []
    }
  }
}

let instance: PermissionRulesService | null = null
export function getPermissionRulesService(explicitDataDir?: string): PermissionRulesService {
  if (!instance) instance = new PermissionRulesService(dataDirOf(explicitDataDir))
  return instance
}

export type { PermissionDecision }
