/**
 * 权限引擎（纯函数，无副作用之外的唯一例外是「读取旧文件生成 diff 预览」）。
 *
 * 三档模式（见 ARCHITECTURE §7）：
 * - read-only：只读工具自动允许；写/执行直接拒绝（提示切换模式）；越界仍会审批；
 * - ask（默认）：读自动；工作区内写/执行自动；危险命令、外部动作与越界询问；
 * - auto（完全访问）：写入、命令、危险操作、外部动作与越界一律自动执行，不弹审批。
 *
 * 显式会话模式（审计报告第 5 项）叠加在权限档位之上：
 * - chat：只允许只读工具 + ask_user；写文件/跑命令/写记忆/目标/计划/子代理等一律**直接拒绝**，
 *   即使会话权限档位是 auto 也一样。这是内核硬拦截，不是提示词约束。
 * - work（缺省）：行为与上面三档完全一致。
 *
 * 「本次会话总是允许」由 Agent 按 sessionId + signature 记忆，本模块只负责算 signature。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type {
  PermissionMode,
  PermissionPreview,
  PermissionRule,
  SessionMode,
  ToolCategory,
  ToolRisk
} from '../shared/types'
import { createUnifiedDiff } from './tools/diff'
import { ToolInputError } from './tools/types'
import { displayPath, inspectWorkspacePath, isExplicitlyAttachedPath, normalizeWorkspace } from './tools/paths'
import { sha256 } from './util'
import { BROWSER_TOOL_NAMES } from './tools/browser-tools'

/* ── 危险命令识别 ─────────────────────────────────────────────── */

export interface DangerousCommandInfo {
  level: 'high'
  reason: string
}

interface DangerRule {
  pattern: RegExp
  reason: string
}

/**
 * 危险命令规则。命中即 risk=high：
 * - 在 read-only 下直接拒绝；
 * - 在 ask 下仍然询问（红色风险），且「始终允许」记忆不生效；
 * - 在 auto（完全访问）下直接执行，由用户事先承担授权范围。
 */
const DANGER_RULES: DangerRule[] = [
  // 只把 `format C:` / `format /fs:...` 当成磁盘格式化；`npm run format` 等格式化工具不误报
  { pattern: /(?:^|[\s;|&])format(?:\.com)?\s+(?:[A-Za-z]:|\/[A-Za-z])/i, reason: '格式化磁盘会清空整块硬盘的数据' },
  { pattern: /\b(?:diskpart|format-volume|clear-disk|initialize-disk)\b/i, reason: '磁盘分区/格式化操作会破坏数据' },
  { pattern: /\b(?:mkfs|fdisk|dd\s+if=)\b/i, reason: '磁盘写入/格式化操作会破坏数据' },
  { pattern: /\b(?:shutdown|restart-computer|stop-computer|logoff)\b/i, reason: '关机/重启会中断用户正在做的事' },
  { pattern: /\bbcdedit\b/i, reason: '修改启动配置可能导致系统无法开机' },
  { pattern: /\breg\s+(?:add|delete|import)\b/i, reason: '修改注册表可能影响系统稳定性' },
  // 递归删除（含 -r -f 分开写、长参数、PowerShell 写法）都按高风险处理
  { pattern: /\brm\b(?=[^\n;|&]*\s(?:-[a-z]*r[a-z]*|--recursive)\b)/i, reason: '递归删除目录，可能删掉重要数据' },
  { pattern: /\b(?:del|erase)\b[^\n;|&]*(?:-recurse|-force)\b/i, reason: '递归/强制删除文件，可能删掉重要数据' },
  { pattern: /\bdel\s+\/[a-z]*[fsq]/i, reason: '强制/静默删除文件，可能删掉重要数据' },
  { pattern: /\b(?:rd|rmdir)\s+\/[a-z]*[sq]/i, reason: '递归删除目录，可能删掉重要数据' },
  { pattern: /remove-item[^\n]*-recurse[^\n]*(?:-force)?/i, reason: '递归删除目录内容，可能删掉重要数据' },
  { pattern: /\bgit\s+push\s+(?:-f|--force)\b/i, reason: '强制推送会覆盖远端仓库历史' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: '硬重置会丢弃未提交的改动' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, reason: '清理未跟踪文件，可能删掉未提交的新文件' },
  {
    pattern: /(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod)[^\n|;]*\|\s*(?:iex|invoke-expression|sh|bash|powershell|cmd)\b/i,
    reason: '从网络下载脚本并直接执行，可能运行恶意代码'
  },
  { pattern: /\b(?:iex|invoke-expression)\s*[(\s]/i, reason: '动态执行字符串代码，可能运行恶意命令' },
  { pattern: /(?:powershell|pwsh)[^\n]*(?:-enc|-encodedcommand)\b/i, reason: '执行 Base64 编码的隐藏命令，无法审查内容' },
  { pattern: /downloadstring\s*\(/i, reason: '从网络下载并执行代码，可能运行恶意代码' },
  { pattern: /\b(?:net\s+user|net\s+localgroup)\b/i, reason: '修改系统账户/用户组' },
  { pattern: /\bschtasks\s+\/create\b/i, reason: '创建计划任务会长期驻留系统' },
  { pattern: /\bset-executionpolicy\b/i, reason: '修改 PowerShell 脚本执行策略，降低系统安全性' },
  { pattern: /\b(?:takeown|icacls|cacls)\b/i, reason: '修改文件所有权/ACL 可能破坏系统权限' },
  { pattern: /\b(?:taskkill\s+\/[a-z]*f|stop-process)\b/i, reason: '强制结束进程可能丢失未保存的数据' },
  { pattern: /\bwmic\b[^\n]*\bdelete\b/i, reason: '通过 WMI 删除系统对象' },
  { pattern: /\bvssadmin\s+delete\b/i, reason: '删除卷影副本会破坏系统还原点' },
  { pattern: /\bcipher\s+\/w\b/i, reason: '覆写磁盘空闲空间，可能导致数据无法恢复' },
  { pattern: /\b(?:\.ssh[\\/]|id_rsa|\.dsh[\\/]|credentials(?:\.yaml|\.json)?\b|login\s+data|keychain|\.aws[\\/])/i, reason: '读取凭据/密钥目录属于敏感操作' }
]

/**
 * 命中危险规则返回原因；否则 null。
 *
 * R8 审计修复：按命令段（`;` / `&&` / `||` / 换行）分别匹配，避免
 * 「Remove-Item out/a.py; Get-ChildItem -Recurse ...」这类无害组合被跨段误报为递归删除。
 * 单段内仍用完整正则（例如 `curl ... | iex` 必须整段匹配）。
 */
export function detectDangerousCommand(command: string): DangerousCommandInfo | null {
  if (!command) return null
  const segments = command
    .split(/\r?\n|;|&&|\|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  const candidates = segments.length > 0 ? segments : [command]
  for (const rule of DANGER_RULES) {
    for (const segment of candidates) {
      if (rule.pattern.test(segment)) return { level: 'high', reason: rule.reason }
    }
  }
  return null
}

/** 判断绝对路径是否在工作区内（大小写按平台归一） */
function insideWorkspace(candidate: string, workspaceReal: string): boolean {
  const toPosix = (value: string): string => value.replace(/\\/g, '/')
  const lower = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const target = lower(toPosix(candidate)).replace(/\/+$/, '')
  const root = lower(toPosix(workspaceReal)).replace(/\/+$/, '')
  return target === root || target.startsWith(`${root}/`)
}

/**
 * 命令里引用了工作区外的路径（Windows 盘符 / Unix 系统目录 / `..` 跳出）。
 *
 * R8 审计修复：`..` 不再一律判越界，而是按命令里的 `cd` 链解析出实际目录后判断；
 * 例如 `cd out; python count.py ../in/sample.csv` 中 `../in` 仍落在工作区内，不应误报。
 */
export function detectOutsidePathInCommand(command: string, workspace: string | null): string | null {
  if (!command || !workspace) return null
  // 统一成 posix 风格再比较，兼容 Windows 盘符 + 正/反斜杠。
  // 绝对路径必须从 token 起点匹配：`tools/tmp/a.js` 里的 `/tmp` 是相对目录，不是系统目录。
  const workspaceReal = normalizeWorkspace(workspace)
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const workspacePosix = fold(workspaceReal.replace(/\\/g, '/')).replace(/\/+$/, '')
  // 普通 URL 里的 /home、/users 等是网址路径，不是本机文件；先剥离再扫描。
  // file: 指向本机文件，不能当普通网址忽略（curl 等命令可借它读盘），保留后单独检查。
  const withoutUrls = command.replace(/\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s"'`|;&)]+/gi, ' ')
  const fileUrl = /\bfile:(?:\/\/)?[^\s"'`|;&)]+/i.exec(withoutUrls)
  if (fileUrl) return fileUrl[0]
  const tokens =
    withoutUrls.match(
      /(?<![A-Za-z0-9._/\\:-])[A-Za-z]:[\\/][^\s"'`|;&]+|(?<![A-Za-z0-9._/\\:-])(?:\\\\|\/\/)[^\s"'`|;&]+|(?<![A-Za-z0-9._/\\:-])\/(?:etc|usr|bin|sbin|lib|lib64|boot|dev|proc|sys|srv|run|snap|home|users|root|var|opt|tmp|private|mnt|media|applications|library|system|volumes)(?:\/[^\s"'`|;&]*)?/gi
    ) ?? []
  for (const token of tokens) {
    if (/^[a-z]{2,6}:\/\//i.test(token)) continue // http:// / https:// / file:// 等协议头
    const normalized = fold(token.replace(/\\/g, '/')).replace(/\/+$/, '')
    if (normalized === workspacePosix || normalized.startsWith(`${workspacePosix}/`)) continue
    return token
  }

  // 解析 `cd` 链后判断 `..` / 裸相对路径是否真的跳出工作区
  const segments = withoutUrls
    .split(/\r?\n|;|&&|\|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  let cwd = workspaceReal
  for (const segment of segments) {
    const cdMatch = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(segment)
    if (cdMatch) {
      const target = cdMatch[1] ?? cdMatch[2] ?? cdMatch[3] ?? ''
      if (target) {
        const next = isAbsolute(target) ? resolve(target) : resolve(cwd, target)
        if (!insideWorkspace(next, workspaceReal)) return target
        cwd = next
      }
      continue
    }
    for (const match of segment.matchAll(/(?<![A-Za-z0-9._-])\.\.[\\/][^\s"'`;|&)]*|(?<![A-Za-z0-9._-])\.\.(?=$|[\s"'`;|&)])/g)) {
      const token = match[0].replace(/[)"'`;|&]+$/, '')
      if (!token) continue
      const resolved = token === '..' ? resolve(cwd) : resolve(cwd, token)
      if (!insideWorkspace(resolved, workspaceReal)) return token
    }
  }

  // 用户主目录/环境变量展开会绕过上面的字面路径判断（`cd ~`、`$HOME/...`）。
  if (/(?:^|[\s"'`=:(])~[A-Za-z0-9_.-]*(?=$|[\s"'`;|&/\\])/.test(withoutUrls)) {
    return '用户主目录（~）'
  }
  if (
    /(?:\$env:|\$\{env:|\$(?:\{)?(?:HOME|USERPROFILE|HOMEPATH|HOMEDRIVE|TMPDIR|TEMP|TMP|OLDPWD|SYSTEMROOT|WINDIR)(?:\})?(?![A-Za-z0-9_])|%(?:USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|TEMP|TMP|PUBLIC|SYSTEMROOT|WINDIR|PROGRAMFILES|PROGRAMDATA)(?::[^%]*)?%)/i.test(
      withoutUrls
    )
  ) {
    return '环境变量/用户目录展开路径'
  }
  return null
}

/* ── 审批目标与结果 ───────────────────────────────────────────── */

export interface PermissionTarget {
  toolName: string
  category: ToolCategory
  baseRisk: ToolRisk
  input: Record<string, unknown>
  /** UI/审批卡标题（通常来自工具定义的 titleFor） */
  title: string
}

export interface PermissionPolicyContext {
  mode: PermissionMode
  workspace: string | null
  /** 用户显式附加的文件：只读工具访问这些路径不算越界 */
  attachedFiles?: readonly string[]
  isDemo: boolean
  /** 本会话已「始终允许」的 signature 集合 */
  sessionGrants: ReadonlySet<string>
  /** 工作区持久化权限规则（deny 优先；allow 不越过危险命令/外部动作/越界） */
  workspaceRules?: ReadonlyArray<PermissionRule>
  /**
   * 显式会话模式（审计报告第 5 项）：
   * - chat：内核强制只读——只放行只读工具 + ask_user，其余一律拒绝（与权限档位无关）；
   * - work / 缺省：沿用原有权限档位。
   */
  sessionMode?: SessionMode
}

/** 聊天模式额外放行的非 read 类工具（唯一一个：向用户提问，不做任何副作用） */
export const CHAT_MODE_ALLOWED_META_TOOLS: ReadonlySet<string> = new Set(['ask_user'])

/** 研究模式：只读资料 + 联网查证 + 计划/画布，不允许写文件、跑命令、MCP、子代理或目标。 */
export const RESEARCH_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'web_search',
  'web_fetch',
  'todo_write',
  'open_artifact',
  'ask_user',
  'list_skills',
  'read_skill'
])

export function isResearchModeToolAllowed(toolName: string, category: ToolCategory): boolean {
  if (category === 'read') return true
  return RESEARCH_MODE_ALLOWED_TOOLS.has(toolName)
}

/**
 * 聊天模式工具白名单：只读类工具 + ask_user。
 * 内核（工具列表过滤）与权限层（硬拦截）共用同一判定，保证「不是只提示」。
 */
export function isChatModeToolAllowed(toolName: string, category: ToolCategory): boolean {
  if (category === 'read') return true
  return CHAT_MODE_ALLOWED_META_TOOLS.has(toolName)
}

export type PermissionGate =
  | { action: 'allow'; escape?: boolean }
  | { action: 'deny'; reason: string; hint?: string }
  | {
      action: 'ask'
      title: string
      risk: ToolRisk
      summary: string
      signature: string
      preview?: PermissionPreview
      /** 本次审批是否属于「越出工作区」（批准后工具需放行越界路径） */
      escape?: boolean
      /** false = 高风险/外部动作/越界，不提供「始终允许」，每次都必须重新确认 */
      allowAlways: boolean
    }

const PATH_TOOLS = new Set([
  'read_file',
  'read_pdf',
  'read_docx',
  'read_xlsx',
  'read_pptx',
  'write_file',
  'edit_file',
  'delete_file',
  'list_dir',
  'glob',
  'grep',
  'open_artifact'
])

/**
 * R9 / R2-A：会写 Office 文档的工具。signature 必须绑定「输出路径 + 内容/替换参数」，
 * 否则批准一次 write_xlsx/edit_docx 后可换文件或换内容复用（旧实现落到 `tool:default`）。
 */
export const DOCUMENT_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_xlsx', 'edit_docx'])

/** 稳定序列化（对象 key 排序），用于参数指纹，避免 key 顺序影响签名 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

/** 文档写工具的参数指纹：排除路径字段后对其余入参（内容/替换/工作表）取哈希 */
function documentParamsFingerprint(input: Record<string, unknown>, pathKeys: string[]): string {
  const excluded = new Set(pathKeys)
  const rest: Record<string, unknown> = {}
  for (const key of Object.keys(input).sort()) {
    if (excluded.has(key)) continue
    rest[key] = input[key]
  }
  return sha256(stableStringify(rest)).slice(0, 32)
}

/** 文档写工具的目标路径（第一个 path/output_path），用于签名与越界展示 */
export function extractDocumentPath(toolName: string, input: Record<string, unknown>): string | null {
  const keys = toolName === 'edit_docx' ? ['output_path', 'path'] : ['path', 'output_path']
  for (const key of keys) {
    const candidate = input[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

export function extractToolPath(input: Record<string, unknown>): string | null {
  const candidate = input.path
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  return null
}

export function extractCommandCwd(input: Record<string, unknown>): string {
  const candidate = input.cwd
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : '.'
}

/**
 * 判断目标是否命中一条工作区权限规则。
 * - tool：工具名（`*` 表示任意）
 * - prefix：run_command/terminal 的命令前缀
 * - path：写入类工具的目标路径前缀（相对工作区或绝对路径）
 */
export function permissionRuleMatches(
  rule: PermissionRule,
  target: PermissionTarget,
  ctx: PermissionPolicyContext
): boolean {
  if (rule.tool !== '*' && rule.tool !== target.toolName) return false
  if (rule.kind === 'tool') return true
  if (rule.kind === 'prefix') {
    if (target.toolName !== 'run_command' && target.toolName !== 'terminal') return false
    const raw = typeof target.input.command === 'string' ? target.input.command.trim() : ''
    const command = raw.replace(/\s+/g, ' ').trim()
    const prefix = rule.pattern.replace(/\s+/g, ' ').trim()
    if (!command || !prefix) return false
    // 完全一致视为用户针对这条完整命令授权，即使包含管道
    if (command === prefix) return true
    // 必须有 token 边界：允许「npm test -- --runInBand」，但不能让「npm test」放行「npm testing」
    if (!command.startsWith(`${prefix} `)) return false
    // 前缀扩展不能覆盖拼接命令（换行、分号、管道等），否则「npm test\n任意命令」会直接放行
    return !/[;&|\r\n]/.test(raw)
  }
  if (rule.kind === 'path') {
    if (target.category !== 'write' && !DOCUMENT_WRITE_TOOLS.has(target.toolName)) return false
    const raw = DOCUMENT_WRITE_TOOLS.has(target.toolName)
      ? extractDocumentPath(target.toolName, target.input)
      : extractToolPath(target.input)
    if (!raw) return false
    try {
      const candidate = ctx.workspace ? inspectWorkspacePath(raw, ctx.workspace).absolute : resolve(raw)
      const prefix = ctx.workspace
        ? inspectWorkspacePath(rule.pattern, ctx.workspace).absolute
        : resolve(rule.pattern)
      const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
      const normalizedCandidate = fold(candidate.replace(/\\/g, '/')).replace(/\/+$/, '')
      const normalizedPrefix = fold(prefix.replace(/\\/g, '/')).replace(/\/+$/, '')
      return (
        normalizedCandidate === normalizedPrefix ||
        normalizedCandidate.startsWith(`${normalizedPrefix}/`)
      )
    } catch {
      return false
    }
  }
  return false
}

/** 有文件系统副作用的元工具（category=meta 但会写盘，只读模式必须拒绝） */
export const WRITE_SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set(['remember'])

/** computer-use 工具名：权限层与工具模块共用同一份清单，避免工具模块反向修改权限集合 */
export const COMPUTER_TOOL_NAMES = [
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key'
] as const

export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number]

/**
 * 外部动作工具（R8 审计第6项）：会联网或启动外部 MCP/桌面进程。
 * 即使 `permissionMode=auto` 也必须逐次审批；只读模式由 writeLike 分支直接拒绝。
 * sessionGrants 不参与外部动作——一次授权不能复用于其它 URL/server/tool。
 */
export const EXTERNAL_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'web_fetch',
  'mcp_list',
  'mcp_call',
  'mcp_resources',
  'mcp_prompt',
  ...BROWSER_TOOL_NAMES,
  ...COMPUTER_TOOL_NAMES
])

/** 本会话「始终允许」的签名：同一工具 + 完全相同的目标与参数 */
export function permissionSignature(target: PermissionTarget, ctx: PermissionPolicyContext): string {
  const toolName = target.toolName
  try {
    if (toolName === 'run_command') {
      const cwd = extractCommandCwd(target.input)
      const command = typeof target.input.command === 'string' ? target.input.command : ''
      // R7 审计修复：只绑定「完全相同的命令 + 参数 + 工作目录」。
      // 旧实现只取首词，批准 `node a.js` 会连 `node b.js` 一起放行。
      const normalizedCommand = command.trim().replace(/\s+/g, ' ')
      const cwdAbs = ctx.workspace
        ? inspectWorkspacePath(cwd, ctx.workspace).absolute
        : normalizeWorkspace(cwd)
      return `${toolName}:${cwdAbs.toLowerCase()}:${sha256(normalizedCommand).slice(0, 32)}`
    }
    if (DOCUMENT_WRITE_TOOLS.has(toolName)) {
      const pathKeys = toolName === 'edit_docx' ? ['path', 'output_path'] : ['path']
      const targetPath = extractDocumentPath(toolName, target.input)
      const abs = targetPath
        ? ctx.workspace
          ? inspectWorkspacePath(targetPath, ctx.workspace).absolute
          : targetPath
        : 'workspace'
      // 输入路径也参与绑定：edit_docx 换输入文档同样是另一个操作
      const inputPath =
        toolName === 'edit_docx' && typeof target.input.path === 'string'
          ? ctx.workspace
            ? inspectWorkspacePath(target.input.path, ctx.workspace).absolute
            : target.input.path
          : ''
      return `${toolName}:${abs.toLowerCase()}:${inputPath.toLowerCase()}:${documentParamsFingerprint(target.input, pathKeys)}`
    }
    if (toolName === 'write_file') {
      const raw = extractToolPath(target.input)
      if (!raw) return `${toolName}:workspace`
      const abs = ctx.workspace ? inspectWorkspacePath(raw, ctx.workspace).absolute : raw
      const content = typeof target.input.content === 'string' ? target.input.content : ''
      const append = target.input.append === true ? 'append' : 'overwrite'
      // 参数也要绑定：同一路径换内容 = 另一次授权
      return `${toolName}:${abs.toLowerCase()}:${append}:${sha256(content).slice(0, 16)}`
    }
    if (toolName === 'edit_file') {
      const raw = extractToolPath(target.input)
      if (!raw) return `${toolName}:workspace`
      const abs = ctx.workspace ? inspectWorkspacePath(raw, ctx.workspace).absolute : raw
      const oldString = typeof target.input.old_string === 'string' ? target.input.old_string : ''
      const newString = typeof target.input.new_string === 'string' ? target.input.new_string : ''
      const replaceAll = target.input.replace_all === true ? 'all' : 'one'
      return `${toolName}:${abs.toLowerCase()}:${replaceAll}:${sha256(`${oldString}\u0000${newString}`).slice(0, 16)}`
    }
    if (toolName === 'remember') {
      const text = typeof target.input.text === 'string' ? target.input.text : ''
      return `${toolName}:${sha256(text).slice(0, 16)}`
    }
    if (toolName === 'terminal') {
      const action = typeof target.input.action === 'string' ? target.input.action : ''
      const id = typeof target.input.id === 'string' ? target.input.id : ''
      if (action === 'run' || action === 'start') {
        const command = typeof target.input.command === 'string' ? target.input.command : ''
        const normalized = command.trim().replace(/\s+/g, ' ')
        return `${toolName}:${action}:${(ctx.workspace ?? '').toLowerCase()}:${sha256(normalized).slice(0, 32)}`
      }
      if (action === 'write') {
        // stdin 的语义无法静态判断；同一 id 换内容必须是另一次授权
        const data = typeof target.input.data === 'string' ? target.input.data : ''
        return `${toolName}:write:${id}:${sha256(data).slice(0, 16)}`
      }
      return `${toolName}:${action}:${id}`
    }
    if (PATH_TOOLS.has(toolName)) {
      const raw = extractToolPath(target.input)
      if (!raw) return `${toolName}:workspace`
      const abs = ctx.workspace ? inspectWorkspacePath(raw, ctx.workspace).absolute : raw
      return `${toolName}:${abs.toLowerCase()}`
    }
  } catch (err) {
    if (!(err instanceof ToolInputError)) throw err
  }
  return `${toolName}:default`
}

/* ── 越界判断 ─────────────────────────────────────────────────── */

interface EscapeInfo {
  escaped: boolean
  /** 越界后的绝对路径（展示用） */
  absolute?: string
  /** 路径在工作区内的相对展示（未越界时） */
  display?: string
}

function inspectEscape(
  target: PermissionTarget,
  workspace: string | null,
  attachedFiles: readonly string[] = []
): EscapeInfo {
  if (!workspace) return { escaped: false }
  const rawPaths: string[] = []
  if (target.toolName === 'run_command') rawPaths.push(extractCommandCwd(target.input))
  else if (PATH_TOOLS.has(target.toolName)) {
    const path = extractToolPath(target.input)
    if (path) rawPaths.push(path)
  } else if (DOCUMENT_WRITE_TOOLS.has(target.toolName)) {
    // edit_docx 同时读输入文档、写输出文档：任一越界都要审批
    const keys = target.toolName === 'edit_docx' ? ['output_path', 'path'] : ['path', 'output_path']
    for (const key of keys) {
      const value = target.input[key]
      if (typeof value === 'string' && value.trim()) rawPaths.push(value.trim())
    }
  }
  if (rawPaths.length === 0) return { escaped: false }
  let insideDisplay: string | undefined
  for (const rawPath of rawPaths) {
    try {
      const resolved = inspectWorkspacePath(rawPath, workspace)
      if (!resolved.inside) {
        // 用户明确附加的 PDF/Office 文件：只读工具直接放行，不重复审批
        if (target.category === 'read' && isExplicitlyAttachedPath(resolved, attachedFiles)) continue
        return {
          escaped: true,
          absolute: resolved.absolute,
          display: displayPath(resolved.absolute, workspace)
        }
      }
      insideDisplay ??= displayPath(resolved.absolute, workspace)
    } catch (err) {
      if (!(err instanceof ToolInputError)) throw err
    }
  }
  return { escaped: false, ...(insideDisplay ? { display: insideDisplay } : {}) }
}

/* ── 预览构造 ─────────────────────────────────────────────────── */

function previewContentPreview(content: string, max = 1800): string {
  return content.length > max ? `${content.slice(0, max)}\n…（预览已截断）` : content
}

/** 新建文件的 diff 预览：用 /dev/null 作为旧文件，渲染层即可按标准 unified diff 展示新增行 */
function buildNewFileDiff(display: string, content: string): string {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const shown = lines.slice(0, 200)
  const body = shown.map((line) => `+${line}`)
  if (lines.length > shown.length) body.push(`+…（还有 ${lines.length - shown.length} 行未展示）`)
  return [`--- /dev/null`, `+++ b/${display}`, `@@ -0,0 +1,${lines.length} @@`, ...body].join('\n')
}

function safeReadText(absolutePath: string): string | null {
  try {
    if (!existsSync(absolutePath)) return null
    const stat = statSync(absolutePath)
    if (!stat.isFile() || stat.size > 512 * 1024) return null
    return readFileSync(absolutePath, 'utf8')
  } catch {
    return null
  }
}

function buildWritePreview(target: PermissionTarget, ctx: PermissionPolicyContext): PermissionPreview | undefined {
  const workspace = ctx.workspace
  if (!workspace) return undefined
  const rawPath = extractToolPath(target.input)
  if (!rawPath) return undefined
  let absolute: string
  let display: string
  try {
    const resolved = inspectWorkspacePath(rawPath, workspace)
    absolute = resolved.absolute
    display = displayPath(resolved.absolute, workspace)
  } catch {
    return undefined
  }
  const before = safeReadText(absolute)
  if (target.toolName === 'write_file') {
    const content = typeof target.input.content === 'string' ? target.input.content : ''
    if (before === null) {
      // 新建文件也用标准 diff 形式，审批卡的「改动预览」才能逐行展示
      return { kind: 'diff', content: buildNewFileDiff(display, content) }
    }
    const diff = createUnifiedDiff(before, content, display)
    return { kind: 'diff', content: diff.patch || `文件内容没有变化：${display}` }
  }
  if (target.toolName === 'edit_file') {
    const oldString = typeof target.input.old_string === 'string' ? target.input.old_string : ''
    const newString = typeof target.input.new_string === 'string' ? target.input.new_string : ''
    if (before !== null && oldString) {
      const next = target.input.replace_all === true ? before.split(oldString).join(newString) : before.replace(oldString, () => newString)
      const diff = createUnifiedDiff(before, next, display)
      return { kind: 'diff', content: diff.patch || `将修改 ${display}` }
    }
    return { kind: 'diff', content: `修改文件 ${display}\n- ${oldString}\n+ ${newString}` }
  }
  if (target.toolName === 'delete_file') {
    if (before !== null) {
      const diff = createUnifiedDiff(before, '', display)
      return { kind: 'diff', content: diff.patch || `删除文件 ${display}` }
    }
    return { kind: 'text', content: `删除文件：${display}` }
  }
  return undefined
}

function buildPreview(target: PermissionTarget, ctx: PermissionPolicyContext): PermissionPreview | undefined {
  const escape = inspectEscape(target, ctx.workspace, ctx.attachedFiles)
  if (escape.escaped && escape.absolute) {
    return { kind: 'path', content: `工作区外路径：${escape.absolute}` }
  }
  switch (target.toolName) {
    case 'run_command': {
      const command = typeof target.input.command === 'string' ? target.input.command : ''
      return { kind: 'command', content: command }
    }
    case 'terminal': {
      const action = typeof target.input.action === 'string' ? target.input.action : ''
      if (action === 'run' || action === 'start') {
        const command = typeof target.input.command === 'string' ? target.input.command : ''
        return { kind: 'command', content: command }
      }
      if (action === 'write') {
        const data = typeof target.input.data === 'string' ? target.input.data : ''
        return { kind: 'text', content: `写入终端 stdin：\n${data}` }
      }
      const id = typeof target.input.id === 'string' ? target.input.id : ''
      return { kind: 'text', content: `终端操作：${action || '未知'}${id ? ` · ${id}` : ''}` }
    }
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
      return buildWritePreview(target, ctx)
    case 'read_file':
    case 'list_dir':
    case 'glob':
    case 'grep': {
      const raw = extractToolPath(target.input)
      return raw ? { kind: 'path', content: escape.display ?? raw } : undefined
    }
    case 'open_artifact': {
      const title = typeof target.input.title === 'string' ? target.input.title : '画布产物'
      const raw = extractToolPath(target.input)
      return { kind: 'text', content: `在画布中打开：${title}${raw ? `（${raw}）` : ''}` }
    }
    case 'remember': {
      const text = typeof target.input.text === 'string' ? target.input.text : ''
      return { kind: 'text', content: text }
    }
    case 'task': {
      const prompt = typeof target.input.prompt === 'string' ? target.input.prompt : ''
      return { kind: 'text', content: previewContentPreview(prompt) }
    }
    default:
      return undefined
  }
}

/* ── 人类可读摘要 ─────────────────────────────────────────────── */

function summarize(target: PermissionTarget, ctx: PermissionPolicyContext): string {
  if (target.toolName === 'run_command') {
    const command = typeof target.input.command === 'string' ? target.input.command : ''
    const oneLine = command.replace(/\s+/g, ' ').trim()
    return `运行命令：${oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine}`
  }
  if (target.toolName === 'terminal') {
    const action = typeof target.input.action === 'string' ? target.input.action : ''
    const oneLine = (value: string): string => {
      const text = value.replace(/\s+/g, ' ').trim()
      return text.length > 160 ? `${text.slice(0, 160)}…` : text
    }
    if (action === 'run' || action === 'start') {
      const command = typeof target.input.command === 'string' ? target.input.command : ''
      return `${action === 'start' ? '启动后台任务' : '运行终端命令'}：${oneLine(command)}`
    }
    if (action === 'write') {
      const data = typeof target.input.data === 'string' ? target.input.data : ''
      return `向终端写入 stdin（可能被执行）：${oneLine(data)}`
    }
    if (action === 'read') return '读取终端/后台任务输出'
    if (action === 'list') return '查看终端与后台任务列表'
    if (action === 'stop') return '停止终端/后台任务'
    if (action === 'restart') return '重新启动终端/后台任务'
  }
  const escape = inspectEscape(target, ctx.workspace, ctx.attachedFiles)
  if (escape.escaped && escape.absolute) return `访问工作区外的路径：${escape.absolute}`
  const raw = extractToolPath(target.input)
  const shown = raw ? escape.display ?? raw : ''
  switch (target.toolName) {
    case 'write_xlsx':
    case 'edit_docx': {
      const rawPath = extractDocumentPath(target.toolName, target.input)
      return rawPath ? `写入文档：${escape.display ?? rawPath}` : target.title
    }
    case 'write_file':
      return shown ? `写入文件：${shown}` : '写入文件'
    case 'edit_file':
      return shown ? `修改文件：${shown}` : '修改文件'
    case 'delete_file':
      return shown ? `删除文件：${shown}` : '删除文件'
    case 'read_file':
      return shown ? `读取文件：${shown}` : '读取文件'
    case 'open_artifact': {
      const title = typeof target.input.title === 'string' ? target.input.title : ''
      return title ? `在画布中打开：${title}` : '在画布中打开产物'
    }
    case 'remember':
      return '记录一条项目记忆（写入 .morrow/MEMORY.md）'
    case 'task':
      return `启动子代理：${typeof target.input.description === 'string' ? target.input.description : '处理子任务'}`
    default:
      return target.title
  }
}

/* ── 主入口 ───────────────────────────────────────────────────── */

/**
 * 判断一次工具调用是否放行 / 需要审批 / 直接拒绝。
 * 注意：这里不执行任何工具，也不弹窗；Agent 根据返回结果决定挂起或继续。
 */
function summarizeExternalAction(target: PermissionTarget): string {
  if (target.toolName === 'web_fetch') {
    const url = typeof target.input.url === 'string' ? target.input.url : ''
    return `读取公网网页（会联网发送 GET 请求）：${url.slice(0, 300)}`
  }
  if (target.toolName === 'mcp_list') {
    const server = typeof target.input.server === 'string' ? target.input.server : ''
    return `连接 MCP server 读取工具清单${server ? `：${server}` : ''}（会启动本机进程或发起网络请求，不执行业务操作）`
  }
  if (target.toolName === 'mcp_call') {
    const server = typeof target.input.server === 'string' ? target.input.server : '?'
    const tool = typeof target.input.tool === 'string' ? target.input.tool : '?'
    let args = '{}'
    try {
      args = JSON.stringify(target.input.arguments ?? {})
    } catch {
      args = '（无法序列化）'
    }
    return `调用外部 MCP 工具：${server}.${tool}，参数：${args.slice(0, 400)}（会启动本机 MCP server 进程）`
  }
  return target.title
}

export function evaluatePermission(target: PermissionTarget, ctx: PermissionPolicyContext): PermissionGate {
  // 聊天模式：最高优先级的硬拦截。只放行只读工具与 ask_user，其余无论权限档位、
  // 是否演示模式，一律拒绝——保证「auto + chat」甚至「demo + chat」也不会写文件或跑命令。
  if (ctx.sessionMode === 'chat' && !isChatModeToolAllowed(target.toolName, target.category)) {
    const verb =
      target.category === 'exec'
        ? '运行命令或调用外部工具'
        : target.category === 'write'
          ? '修改文件'
          : target.toolName === 'update_goal'
            ? '推进目标'
            : '执行这个操作'
    return {
      action: 'deny',
      reason: `当前是「聊天模式」：Morrow 只讨论和读取资料，不能${verb}。`,
      hint: '需要真正动手时，请把输入框旁的「聊天 / 工作」切到「工作」后再发一次。'
    }
  }
  if (ctx.sessionMode === 'research' && !isResearchModeToolAllowed(target.toolName, target.category)) {
    return {
      action: 'deny',
      reason: `当前是「深度研究模式」：只能查资料和写研究报告，不能${target.category === 'write' ? '修改文件' : '执行这个操作'}。`,
      hint: '研究报告会用画布成品保存；需要改文件或运行命令时，请切回工作模式。'
    }
  }

  // 演示模式：不弹审批（剧本已固定，安全）
  if (ctx.isDemo) return { action: 'allow' }

  const escape = inspectEscape(target, ctx.workspace, ctx.attachedFiles)
  const signature = permissionSignature(target, ctx)
  const terminalAction =
    target.toolName === 'terminal' && typeof target.input.action === 'string' ? target.input.action : ''

  // 只读模式：写文件 / 运行命令 / 有写盘副作用的元工具（remember）一律拒绝。
  // R7 审计修复：
  // - 旧实现先 `category==='meta'` 放行，只读模式下 remember 仍会写 .morrow/MEMORY.md；
  // - 旧实现先处理越界再判断只读，越界写会变成「询问」而不是直接禁止。
  const writeLike =
    target.category === 'write' || target.category === 'exec' || WRITE_SIDE_EFFECT_TOOLS.has(target.toolName)
  if (ctx.mode === 'read-only' && writeLike) {
    if (target.toolName === 'remember') {
      return {
        action: 'deny',
        reason: '当前是「只读模式」，Morrow 不能写入项目记忆。',
        hint: '需要记录长期信息时，请把输入框下方的权限切到「询问」或「完全访问」后重试。'
      }
    }
    return {
      action: 'deny',
      reason:
        target.category === 'exec'
          ? '当前是「只读模式」，Morrow 不能运行命令或调用外部工具。'
          : '当前是「只读模式」，Morrow 不能修改文件或写入记忆。',
      hint: '如果确实需要执行，请把输入框下方的权限切到「询问」或「完全访问」后重试。'
    }
  }

  if (escape.escaped) {
    // 完全访问：用户已明确选择「无需任何批准」，越界操作也直接执行；
    // 但聊天/研究等受限会话仍保留审批边界，不能借档位绕过模式限制。
    if (ctx.mode === 'auto' && (ctx.sessionMode === undefined || ctx.sessionMode === 'work')) {
      return { action: 'allow', escape: true }
    }
    return {
      action: 'ask',
      title: target.title,
      risk: 'high',
      summary: `需要访问工作区以外的位置：${escape.absolute}`,
      signature,
      escape: true,
      allowAlways: false,
      preview: buildPreview(target, ctx)
    }
  }

  const rules = ctx.workspaceRules ?? []
  const deniedByRule = rules.find(
    (rule) => rule.decision === 'deny' && permissionRuleMatches(rule, target, ctx)
  )
  if (deniedByRule) {
    return {
      action: 'deny',
      reason: `工作区规则禁止这个操作（${deniedByRule.kind === 'prefix' ? '命令前缀' : deniedByRule.kind === 'path' ? '路径' : '工具'}：${deniedByRule.pattern}）。`,
      hint: '如果确实需要执行，请到设置 → 权限 → 工作区规则里删除或调整这条规则。'
    }
  }

  if (target.category === 'meta') return { action: 'allow' }
  if (target.category === 'read') return { action: 'allow' }

  // R8 外部动作：web_fetch / mcp_call。只读已在 writeLike 分支拒绝；
  // ask 下必须逐次审批（不查 sessionGrants），避免在「询问」档静默外发/启动外部进程。
  if (EXTERNAL_ACTION_TOOLS.has(target.toolName)) {
    if (ctx.mode === 'auto') return { action: 'allow' }
    return {
      action: 'ask',
      title: target.title,
      risk: target.baseRisk,
      summary: summarizeExternalAction(target),
      signature,
      allowAlways: false,
      preview: buildPreview(target, ctx)
    }
  }

  // 写 / 执行（read-only 已在上方直接拒绝）
  if (target.toolName === 'run_command' || target.toolName === 'terminal') {
    if (target.toolName === 'terminal' && terminalAction === 'write') {
      // 向已有 shell/任务注入 stdin 等价于执行任意内容，无法判断危险性。
      // 完全访问放行；询问档每次都单独确认。
      if (ctx.mode === 'auto') return { action: 'allow' }
      return {
        action: 'ask',
        title: target.title,
        risk: 'high',
        summary: summarize(target, ctx),
        signature,
        allowAlways: false,
        preview: buildPreview(target, ctx)
      }
    }
    const command =
      target.toolName === 'run_command'
        ? typeof target.input.command === 'string'
          ? target.input.command
          : ''
        : terminalAction === 'run' || terminalAction === 'start'
          ? typeof target.input.command === 'string'
            ? target.input.command
            : ''
          : ''
    const danger = detectDangerousCommand(command)
    if (danger) {
      if (ctx.mode === 'auto') return { action: 'allow' }
      return {
        action: 'ask',
        title: target.title,
        risk: 'high',
        summary: `高风险命令（${danger.reason}）：${command.replace(/\s+/g, ' ').slice(0, 160)}`,
        signature,
        allowAlways: false,
        preview: buildPreview(target, ctx)
      }
    }
    const outsidePath = detectOutsidePathInCommand(command, ctx.workspace)
    if (outsidePath) {
      if (ctx.mode === 'auto') return { action: 'allow', escape: true }
      return {
        action: 'ask',
        title: target.title,
        risk: 'high',
        summary: `命令引用了工作区外的路径：${outsidePath}`,
        signature,
        allowAlways: false,
        preview: buildPreview(target, ctx)
      }
    }
  }

  // 工作区 allow 规则：危险命令、工作区外路径、外部动作与只读模式都已提前处理，
  // 到这里才允许规则自动放行。
  const allowedByRule = rules.find(
    (rule) => rule.decision === 'allow' && permissionRuleMatches(rule, target, ctx)
  )
  if (allowedByRule) return { action: 'allow' }

  if (ctx.sessionGrants.has(signature)) return { action: 'allow' }
  // 完全访问：一切直接执行；询问档等价于旧版「自动」：工作区内写/执行直接放行。
  // 危险命令、外部动作、越界与终端写入已在上面单独处理。
  if (ctx.mode === 'auto' || ctx.mode === 'ask') return { action: 'allow' }

  return {
    action: 'ask',
    title: target.title,
    risk: target.baseRisk,
    summary: summarize(target, ctx),
    signature,
    allowAlways:
      target.toolName === 'terminal'
        ? terminalAction === 'run' || terminalAction === 'start'
        : true,
    preview: buildPreview(target, ctx)
  }
}

/** 审批被拒绝时回灌给模型的结果文案（人类可读，模型据此换方案） */
export function deniedMessage(target: PermissionTarget, reason: 'user' | 'unattended' = 'user'): { error: string; hint: string } {
  if (reason === 'unattended') {
    return {
      error: '定时任务无人值守：这个操作需要人工授权，已自动拒绝。',
      hint: '不要重试同一个操作；改用不需要额外授权的做法，或在结果里说明需要用户手动处理的部分。'
    }
  }
  if (target.toolName === 'web_fetch') {
    return {
      error: '用户拒绝这次网页读取。',
      hint: '不要重复请求同一个网址；先说明要查什么、为什么需要联网，或改用本地资料/其它来源。'
    }
  }
  if (target.toolName === 'mcp_call') {
    return {
      error: '用户拒绝这次 MCP 外部工具调用。',
      hint: '不要再次尝试同一个调用；先说明要调用的 server/tool 与目的，或改用内置工具完成任务。'
    }
  }
  if (target.toolName === 'mcp_list') {
    return {
      error: '用户拒绝这次 MCP 工具清单读取。',
      hint: '不要反复请求连接；先说明要连接哪个 server、为什么需要它，或改用内置工具完成任务。'
    }
  }
  if (target.category === 'exec') {
    return {
      error: '用户拒绝了这次命令执行。',
      hint: '不要重复执行同一条命令。可以换一种更安全的方式（例如只读命令、先解释目的），或者询问用户希望在哪种方式下继续。'
    }
  }
  if (target.toolName === 'write_file' || target.toolName === 'edit_file' || target.toolName === 'delete_file') {
    return {
      error: '用户拒绝了这次文件修改。',
      hint: '不要再次尝试同样的修改。请先向用户说明你打算改什么、为什么改，等用户确认后再试；或者改为只读的分析/建议。'
    }
  }
  return {
    error: '用户拒绝了这次操作。',
    hint: '不要重复同样的调用。请换一种用户更容易接受的方式，或先询问用户的偏好。'
  }
}
