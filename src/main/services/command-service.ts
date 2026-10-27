// 自定义斜杠命令（P1-12）。
import { lstatSync, readdirSync, readFileSync, realpathSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { CustomCommandInfo } from '../../shared/types'

const MAX_FILE_BYTES = 64 * 1024
const MAX_BODY_CHARS = 16 * 1024
const MAX_COMMANDS = 100
const NAME_RE = /^[a-z][a-z0-9-]{0,48}$/i

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseCommandFile(
  raw: string,
  name: string,
  scope: 'project' | 'user',
  path: string
): CustomCommandInfo | null {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const meta: Record<string, string> = {}
  let body = text
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
        if (!match) continue
        meta[match[1].toLowerCase()] = unquote(match[2]).slice(0, 300)
      }
      body = lines.slice(end + 1).join('\n')
    }
  }
  const trimmedBody = body.trim()
  if (!trimmedBody) return null
  const fallbackDescription =
    trimmedBody
      .split('\n')
      .map((line) => line.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').trim())
      .find(Boolean) ?? ''
  const description = (meta.description || fallbackDescription).slice(0, 160)
  const hint = (meta['argument-hint'] ?? '').trim().slice(0, 80)
  return {
    name: name.toLowerCase(),
    description: description || '自定义命令',
    ...(hint ? { argumentHint: hint } : {}),
    scope,
    path,
    body: trimmedBody.slice(0, MAX_BODY_CHARS)
  }
}

function readCommandsFrom(
  dir: string,
  scope: 'project' | 'user',
  into: Map<string, CustomCommandInfo>
): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.toLowerCase().endsWith('.md')) continue
    const name = entry.name.slice(0, -3)
    if (!NAME_RE.test(name)) continue
    // 达到上限后仍允许项目命令覆盖同名用户命令，否则用户的 100 条命令会挤掉项目命令
    if (into.size >= MAX_COMMANDS && !into.has(name.toLowerCase())) continue
    const path = join(dir, entry.name)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
      const command = parseCommandFile(readFileSync(path, 'utf8'), name, scope, path)
      if (command) into.set(command.name, command)
    } catch {
      // 单个命令文件读取失败不影响其它命令
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

/** 项目命令目录必须是工作区内的真实目录；拒绝把 .morrow 链接到工作区外读取文件。 */
function projectCommandsDir(workspace: string): string | null {
  try {
    const root = realpathSync(workspace)
    const dir = realpathSync(join(root, '.morrow', 'commands'))
    return isInside(root, dir) ? dir : null
  } catch {
    return null
  }
}

/** 用户命令先读，项目命令后读（同名时项目覆盖用户）。 */
export function discoverCustomCommands(workspace: string | null, home = homedir()): CustomCommandInfo[] {
  const commands = new Map<string, CustomCommandInfo>()
  readCommandsFrom(join(home, '.morrow', 'commands'), 'user', commands)
  if (workspace) {
    const dir = projectCommandsDir(workspace)
    if (dir) readCommandsFrom(dir, 'project', commands)
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_COMMANDS)
}
