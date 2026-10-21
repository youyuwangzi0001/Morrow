/**
 * 自定义子代理角色（Swarm）。
 *
 * 来源：<workspace>/.morrow/agents/*.md 与 ~/.morrow/agents/*.md。
 * frontmatter：description / title / tools（逗号或空格分隔）/ read-only（true/false）
 * 正文是角色专属系统提示。项目覆盖同名用户角色；内置角色名保留，不能被覆盖。
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { BUILTIN_AGENT_ROLES } from '../../core/agent-roles'
import type { SubagentRole } from '../../core/types'

const MAX_FILE_BYTES = 32 * 1024
const MAX_BODY_CHARS = 8000
const MAX_ROLES = 32
const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/i

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseAgentFile(
  raw: string,
  name: string,
  scope: 'project' | 'user',
  path: string
): SubagentRole | null {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const meta: Record<string, string> = {}
  let body = text
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
        if (match) meta[match[1].toLowerCase()] = unquote(match[2]).slice(0, 300)
      }
      body = lines.slice(end + 1).join('\n')
    }
  }
  const systemPrompt = body.trim().slice(0, MAX_BODY_CHARS)
  if (!systemPrompt) return null
  const tools = [
    ...new Set(
      (meta.tools ?? '')
        .split(/[,\s]+/)
        .map((tool) => tool.trim().toLowerCase())
        .filter((tool) => /^[a-z][a-z0-9_]{0,60}$/.test(tool))
        .slice(0, 40)
    )
  ]
  const readOnly = (meta['read-only'] ?? meta.readonly ?? '').trim().toLowerCase()
  return {
    name: name.toLowerCase(),
    title: (meta.title || meta.name || name).slice(0, 40),
    description: (meta.description || systemPrompt.split('\n').find(Boolean) || '自定义子代理').slice(0, 160),
    systemPrompt,
    // 显式写了 tools 但全部无效/为空时保留空数组，表示「不允许任何工具」，避免退化成全部工具
    ...(meta.tools !== undefined ? { tools } : {}),
    ...(readOnly === 'true' || readOnly === 'yes' || readOnly === '1' ? { readOnly: true } : {}),
    source: scope
  }
}

function readAgentsFrom(dir: string, scope: 'project' | 'user', into: Map<string, SubagentRole>): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const name = entry.name.slice(0, -3)
    if (!NAME_RE.test(name)) continue
    const reserved = BUILTIN_AGENT_ROLES.some((role) => role.name === name.toLowerCase())
    if (reserved) continue
    // 达到上限后仍允许项目角色覆盖同名用户角色
    if (into.size >= MAX_ROLES && !into.has(name.toLowerCase())) continue
    const path = join(dir, entry.name)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
      const role = parseAgentFile(readFileSync(path, 'utf8'), name, scope, path)
      if (role) into.set(role.name, role)
    } catch {
      // 单个角色文件失败不影响其它角色
    }
  }
}

function isInside(root: string, target: string): boolean {
  const normalize = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = normalize(root)
  const candidate = normalize(target)
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return candidate === base || candidate.startsWith(prefix)
}

/** 项目角色目录必须是工作区内的真实目录；拒绝把 .morrow 链接到工作区外读取文件。 */
function projectAgentsDir(workspace: string): string | null {
  try {
    const root = realpathSync(workspace)
    const dir = realpathSync(join(root, '.morrow', 'agents'))
    return isInside(root, dir) ? dir : null
  } catch {
    return null
  }
}

/** 内置角色 + 自定义角色；项目覆盖同名用户角色。 */
export function loadAgentRoles(workspace: string | null, home = homedir()): SubagentRole[] {
  const custom = new Map<string, SubagentRole>()
  readAgentsFrom(join(home, '.morrow', 'agents'), 'user', custom)
  if (workspace) {
    const dir = projectAgentsDir(workspace)
    if (dir) readAgentsFrom(dir, 'project', custom)
  }
  return [...BUILTIN_AGENT_ROLES, ...custom.values()].slice(0, MAX_ROLES + BUILTIN_AGENT_ROLES.length)
}

export interface AgentRoleSummary {
  name: string
  title: string
  description: string
  readOnly: boolean
  tools?: string[]
  source: 'builtin' | 'project' | 'user'
}

export function summarizeAgentRoles(roles: SubagentRole[]): AgentRoleSummary[] {
  return roles.map((role) => ({
    name: role.name,
    title: role.title,
    description: role.description,
    readOnly: role.readOnly === true,
    ...(role.tools ? { tools: role.tools } : {}),
    source: role.source ?? 'builtin'
  }))
}
