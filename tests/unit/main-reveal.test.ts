/**
 * 合并后的 reveal 组：Agent 规则、内置技能、自定义命令/集群成员、权限规则、技能库、会话导出、文件管理器定位。
 * 每个原文件各自包在 describe('<原文件名>') 中；本文件 mock 子进程，因此不包含依赖真实命令的用例。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverAgentRules } from '../../src/main/agent'
import { makeTempDir, makeTempWorkspace } from './helpers/workspace'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { discoverSkills, SKILLS_STATE_FILE_ENV, USER_SKILLS_DIR_ENV } from '../../src/core/tool-extra'
import { ensureBuiltinSkills } from '../../src/main/agent'
import { expandCustomCommand } from '../../src/shared/contracts'
import { BUILTIN_AGENT_ROLES } from '../../src/core/agent'
import { loadAgentRoles, summarizeAgentRoles } from '../../src/main/agent'
import { PermissionRulesService } from '../../src/main/runtime'
import { evaluatePermission, permissionRuleMatches, type PermissionPolicyContext, type PermissionTarget } from '../../src/core/agent'
import JSZip from 'jszip'
import { createSkillsFeatureHandlers, createSkillsService, installSkillsRuntimeEnv, SkillsService } from '../../src/main/memory'
import { sessionToMarkdown } from '../../src/main/session'
import { type Session } from '../../src/shared/types'
import { createServer, type Server } from 'node:net'
import { openPathFromUserShell, revealInFileManager } from '../../src/main/workspace'

const electronState = vi.hoisted(() => ({ dataDir: '' }))
const openPathMock = vi.hoisted(() => vi.fn(async () => ''))
const showItemMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? electronState.dataDir : join(electronState.dataDir, name))
  },
  shell: { showItemInFolder: showItemMock, openPath: openPathMock }
}))

let groupTempDataDir = ''

beforeAll(() => {
  groupTempDataDir = mkdtempSync(join(tmpdir(), 'morrow-reveal-group-'))
  electronState.dataDir = groupTempDataDir
})

afterAll(() => {
  rmSync(groupTempDataDir, { recursive: true, force: true })
})

describe('agent-rules.test.ts', () => {
const dirs: string[] = []
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function temp(): string {
  const dir = makeTempDir('morrow-rules-')
  dirs.push(dir)
  return dir
}

describe('agent rules discovery', () => {
  it('@core:skills discovers project, parent and user rules in priority order', () => {
    const root = temp()
    const workspace = join(root, 'repo')
    const home = join(root, 'home')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), 'PARENT-RULE', 'utf8')
    writeFileSync(join(workspace, 'AGENTS.md'), 'PROJECT-AGENTS', 'utf8')
    writeFileSync(join(workspace, 'CLAUDE.md'), 'PROJECT-CLAUDE', 'utf8')
    writeFileSync(join(workspace, 'MORROW.md'), 'PROJECT-MORROW', 'utf8')
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'USER-CLAUDE', 'utf8')

    const discovery = discoverAgentRules(workspace, { homeDir: home })
    expect(discovery.files.filter((file) => file.scope === 'project')).toHaveLength(3)
    expect(discovery.files.some((file) => file.scope === 'parent' && file.name === 'AGENTS.md')).toBe(true)
    expect(discovery.files.some((file) => file.scope === 'user' && file.name === 'CLAUDE.md')).toBe(true)
    const agents = discovery.text.indexOf('PROJECT-AGENTS')
    const claude = discovery.text.indexOf('PROJECT-CLAUDE')
    const parent = discovery.text.indexOf('PARENT-RULE')
    const user = discovery.text.indexOf('USER-CLAUDE')
    expect(agents).toBeGreaterThan(-1)
    expect(agents).toBeLessThan(claude)
    expect(claude).toBeLessThan(parent)
    expect(parent).toBeLessThan(user)
    expect(discovery.text).toContain('安全边界与用户当前指令优先')
  })

  it('@core:skills does not follow rule symlinks outside the workspace', () => {
    const root = temp()
    const workspace = join(root, 'repo')
    mkdirSync(workspace, { recursive: true })
    const secret = join(root, 'secret.md')
    writeFileSync(secret, 'TOP-SECRET', 'utf8')
    const link = join(workspace, 'AGENTS.md')
    try {
      symlinkSync(secret, link, 'file')
    } catch {
      return // 当前环境不允许创建符号链接时跳过
    }
    expect(discoverAgentRules(workspace, { homeDir: join(root, 'home') }).text).not.toContain('TOP-SECRET')

    // 指向工作区内部的链接仍然可用
    rmSync(link)
    const inside = join(workspace, 'real-rules.md')
    writeFileSync(inside, 'IN-WORKSPACE-RULES', 'utf8')
    symlinkSync(inside, link, 'file')
    expect(discoverAgentRules(workspace, { homeDir: join(root, 'home') }).text).toContain('IN-WORKSPACE-RULES')
  })
})
})

describe('builtin-skills.test.ts', () => {
const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morrow-builtin-skills-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('内置技能安装', () => {

  it('@core:skills 旧版未修改的内置技能会随版本升级更新，用户改过的保留', () => {
    const dataDir = tempDir()
    ensureBuiltinSkills(dataDir)
    const markerPath = join(dataDir, 'skills', '.builtin-skills.json')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      version: number
      skills: Record<string, { hash: string; modified?: boolean }>
    }
    const targetPath = join(dataDir, 'skills', 'debugging', 'SKILL.md')
    const oldContent = '---\nname: debugging\ndescription: 旧版\n---\n旧内容\n'
    writeFileSync(targetPath, oldContent, 'utf8')
    marker.version = 4
    marker.skills['debugging'] = { hash: createHash('sha256').update(oldContent).digest('hex') }
    writeFileSync(markerPath, JSON.stringify(marker), 'utf8')

    const changed = ensureBuiltinSkills(dataDir)
    expect(changed).toContain('debugging')
    expect(readFileSync(targetPath, 'utf8')).toContain('先找根因')
  })
})
})

describe('command-service.test.ts', () => {
const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('自定义命令发现', () => {

  it('@core:skills 展开模板：$ARGUMENTS、位置参数与无占位符时追加参数', () => {
    expect(expandCustomCommand('请审查 $1，重点 $2', 'a.ts 性能')).toBe('请审查 a.ts，重点 性能')
    expect(expandCustomCommand('总结：$ARGUMENTS', ' 前后 空格 ')).toBe('总结：前后 空格')
    expect(expandCustomCommand('只写代码', '额外要求')).toBe('只写代码\n\n额外要求')
    expect(expandCustomCommand('固定模板', '   ')).toBe('固定模板')
  })
})
})

describe('custom-agents.test.ts', () => {
const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('自定义集群成员类型', () => {

  it('@core:skills 内置角色始终存在；项目角色覆盖同名用户角色；内置名不可覆盖', () => {
    const home = tempDir('morrow-agents-home-')
    const workspace = tempDir('morrow-agents-ws-')
    mkdirSync(join(home, '.morrow', 'agents'), { recursive: true })
    mkdirSync(join(workspace, '.morrow', 'agents'), { recursive: true })
    writeFileSync(join(home, '.morrow', 'agents', 'audit.md'), '用户级审计\n', 'utf8')
    writeFileSync(join(workspace, '.morrow', 'agents', 'audit.md'), '项目级审计\n', 'utf8')
    writeFileSync(join(workspace, '.morrow', 'agents', 'review.md'), '试图覆盖内置 review\n', 'utf8')
    writeFileSync(join(workspace, '.morrow', 'agents', 'bad name.md'), '忽略\n', 'utf8')

    const roles = loadAgentRoles(workspace, home)
    expect(roles.filter((role) => role.name === 'audit')).toHaveLength(1)
    expect(roles.find((role) => role.name === 'audit')?.systemPrompt).toContain('项目级')
    const review = roles.find((role) => role.name === 'review')
    expect(review?.source).toBe('builtin')
    expect(review?.title).toBe(BUILTIN_AGENT_ROLES.find((role) => role.name === 'review')?.title)

    const summary = summarizeAgentRoles(roles)
    expect(summary.find((role) => role.name === 'audit')).toMatchObject({ source: 'project' })
    expect(summary.map((role) => role.name)).toEqual(expect.arrayContaining(['general', 'explore', 'plan', 'review', 'test', 'docs', 'audit']))
  })
})
})

describe('permission-rules.test.ts', () => {
/**
 * P1-10 权限规则：持久化 CRUD、匹配语义、deny 优先、allow 不越过危险命令/外部动作。
 */

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function target(toolName: string, category: PermissionTarget['category'], input: Record<string, unknown>): PermissionTarget {
  return { toolName, category, baseRisk: category === 'read' ? 'low' : 'medium', input, title: toolName }
}

function policy(workspace: string, rules: ReturnType<PermissionRulesService['list']>): PermissionPolicyContext {
  return { mode: 'ask', workspace, isDemo: false, sessionGrants: new Set(), workspaceRules: rules }
}

describe('PermissionRulesService', () => {
  it('@core:permissions persists workspace rules and logs approvals', () => {
    const dir = makeTempDir('morrow-perm-persist-')
    dirs.push(dir)
    const ws = makeTempWorkspace()
    try {
      const first = new PermissionRulesService(dir)
      first.add({ workspace: ws.root, tool: 'run_command', kind: 'prefix', pattern: 'npm test', decision: 'allow' })
      const second = new PermissionRulesService(dir)
      const rules = second.list(ws.root)
      expect(rules).toHaveLength(1)
      expect(rules[0]).toMatchObject({ tool: 'run_command', kind: 'prefix', pattern: 'npm test', decision: 'allow' })

      second.appendLog({
        at: Date.now(),
        workspace: ws.root,
        sessionId: 's_test',
        toolName: 'write_file',
        title: '写入 out/a.txt',
        decision: 'once'
      })
      const log = second.listLog(ws.root)
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ toolName: 'write_file', decision: 'once' })
    } finally {
      ws.cleanup()
    }
  })
})

describe('permission rules in evaluatePermission', () => {
  it('@core:permissions allows matching command prefixes and denies deny rules with higher priority', () => {
    const ws = makeTempWorkspace()
    try {
      const rules = [
        {
          id: 'r1',
          workspace: ws.root,
          tool: 'run_command',
          kind: 'prefix' as const,
          pattern: 'npm test',
          decision: 'allow' as const,
          createdAt: Date.now()
        },
        {
          id: 'r2',
          workspace: ws.root,
          tool: 'run_command',
          kind: 'prefix' as const,
          pattern: 'git push',
          decision: 'deny' as const,
          createdAt: Date.now()
        }
      ]
      const ctx = policy(ws.root, rules)
      const npm = target('run_command', 'exec', { command: 'npm test -- --runInBand' })
      expect(permissionRuleMatches(rules[0], npm, ctx)).toBe(true)
      expect(evaluatePermission(npm, ctx).action).toBe('allow')
      expect(permissionRuleMatches(rules[0], target('run_command', 'exec', { command: 'npm run build' }), ctx)).toBe(false)
      // 前缀必须有 token 边界，不能把「npm test」的授权扩散到「npm testing」或拼接命令
      expect(permissionRuleMatches(rules[0], target('run_command', 'exec', { command: 'npm testing' }), ctx)).toBe(false)
      expect(permissionRuleMatches(rules[0], target('run_command', 'exec', { command: 'npm test&&npm run build' }), ctx)).toBe(false)
      expect(permissionRuleMatches(rules[0], target('run_command', 'exec', { command: 'npm test\nnpm run build' }), ctx)).toBe(false)
      expect(permissionRuleMatches(rules[0], target('run_command', 'exec', { command: 'npm test ; npm run build' }), ctx)).toBe(false)
      expect(evaluatePermission(target('run_command', 'exec', { command: 'git push origin main' }), ctx).action).toBe('deny')
    } finally {
      ws.cleanup()
    }
  })

  it('@core:permissions allows path prefixes but never overrides dangerous commands or external actions', () => {
    const ws = makeTempWorkspace()
    try {
      const rules = [
        {
          id: 'r1',
          workspace: ws.root,
          tool: 'write_file',
          kind: 'path' as const,
          pattern: 'out',
          decision: 'allow' as const,
          createdAt: Date.now()
        },
        {
          id: 'r2',
          workspace: ws.root,
          tool: 'run_command',
          kind: 'prefix' as const,
          pattern: 'rm -rf',
          decision: 'allow' as const,
          createdAt: Date.now()
        },
        {
          id: 'r3',
          workspace: ws.root,
          tool: 'web_fetch',
          kind: 'tool' as const,
          pattern: '',
          decision: 'allow' as const,
          createdAt: Date.now()
        }
      ]
      const ctx = policy(ws.root, rules)
      expect(evaluatePermission(target('write_file', 'write', { path: 'out/a.txt', content: 'x' }), ctx).action).toBe('allow')
      expect(evaluatePermission(target('write_file', 'write', { path: 'src/a.ts', content: 'x' }), ctx).action).toBe('allow')
      expect(permissionRuleMatches(rules[0], target('write_file', 'write', { path: 'src/a.ts', content: 'x' }), ctx)).toBe(false)
      expect(evaluatePermission(target('run_command', 'exec', { command: 'rm -rf out' }), ctx).action).toBe('ask')
      expect(evaluatePermission(target('web_fetch', 'exec', { url: 'https://example.com' }), ctx).action).toBe('ask')
    } finally {
      ws.cleanup()
    }
  })
})
})

describe('skills.test.ts', () => {
/**
 * R10-H 技能库服务单元测试。
 *
 * 覆盖：发现（工作区 + 用户技能库）、启停状态（含 core 侧过滤）、本地文件夹安装、
 * zip 安装（含单层包装目录）、zip-slip / 绝对路径 / 可执行文件拦截、大小/数量限制、
 * 同名冲突与覆盖安装、删除（工作区技能只读）、详情读取、状态清理、feature:skills:* 处理器。
 */

const cleanup: Array<() => void> = []

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.()
})

function makeTempRoot(name = 'morrow-skills-'): string {
  const root = mkdtempSync(join(tmpdir(), name))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function writeSkill(root: string, name: string, content: string, extra?: Record<string, string>): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
  for (const [relative, text] of Object.entries(extra ?? {})) {
    const target = join(dir, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, text, 'utf8')
  }
  return dir
}

async function makeZip(path: string, entries: Record<string, string | Buffer>): Promise<string> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(entries)) zip.file(name, content)
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  writeFileSync(path, buffer)
  return path
}

/**
 * 手工构造 ZIP（store 模式）：JSZip 在「写」的时候会净化 `..` 路径，
 * 但真实攻击面是「读取别人给的 zip」，所以 zip-slip 用例必须用原始条目名构造。
 */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeRawZip(path: string, entries: Record<string, string>): string {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBuffer.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(0, 8) // store
    local.writeUInt32LE(0, 10) // time/date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuffer.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuffer.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10) // store
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuffer.copy(central, 46)
    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const localBuffer = Buffer.concat(locals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(centrals.length, 8)
  end.writeUInt16LE(centrals.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(localBuffer.length, 16)
  end.writeUInt16LE(0, 20)
  writeFileSync(path, Buffer.concat([localBuffer, centralBuffer, end]))
  return path
}

interface Harness {
  root: string
  workspace: string
  service: SkillsService
}

function makeHarness(): Harness {
  const root = makeTempRoot()
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const service = createSkillsService({ dataDir: join(root, 'data') })
  service.ensureDirs()
  return { root, workspace, service }
}

/* ── 启停 ─────────────────────────────────────────────────────── */

describe('启用 / 禁用（Agent 侧立即生效）', () => {
  it('@core:skills 禁用用户技能后，core 的 discoverSkills 过滤掉它；重新启用恢复', () => {
    const { workspace, service } = makeHarness()
    writeSkill(service.userDir, 'release', '# Release\n发版流程。')
    writeSkill(service.userDir, 'other', '# Other\n别的技能。')
    installSkillsRuntimeEnv(service)
    try {
      expect(discoverSkills(workspace).map((skill) => skill.name).sort()).toEqual(['other', 'release'])
      let snapshot = service.setEnabled('user:release', false, workspace)
      expect(snapshot.skills.find((skill) => skill.id === 'user:release')?.enabled).toBe(false)
      expect(discoverSkills(workspace).map((skill) => skill.name)).toEqual(['other'])
      snapshot = service.setEnabled('user:release', true, workspace)
      expect(snapshot.skills.find((skill) => skill.id === 'user:release')?.enabled).toBe(true)
      expect(discoverSkills(workspace).map((skill) => skill.name).sort()).toEqual(['other', 'release'])
    } finally {
      delete process.env[USER_SKILLS_DIR_ENV]
      delete process.env[SKILLS_STATE_FILE_ENV]
    }
  })
})

/* ── zip 安装 ─────────────────────────────────────────────────── */

describe('从 .zip 安装', () => {
  it('@core:skills 正常 zip（带单层包装目录）解压安装，英文/中文内容与资源都在', async () => {
    const { root, workspace, service } = makeHarness()
    const zipPath = await makeZip(join(root, 'release.zip'), {
      'release/SKILL.md': '---\ndescription: 从 zip 安装的技能\n---\n# Release\n发布流程。',
      'release/checklist.md': '- 检查 changelog\n- 打 tag\n',
      'release/assets/cover.png': Buffer.from([0x89, 0x50, 0x4e, 0x47])
    })
    const result = await service.install(zipPath, workspace)
    expect(result.installed).toMatchObject({ name: 'release', source: 'user', enabled: true })
    expect(readFileSync(join(service.userDir, 'release', 'SKILL.md'), 'utf8')).toContain('发布流程')
    expect(existsSync(join(service.userDir, 'release', 'assets', 'cover.png'))).toBe(true)
    expect(result.installed.resources).toEqual(expect.arrayContaining(['assets/', 'checklist.md']))
  })

  it('@core:skills zip-slip（../、绝对路径）被拒绝，且不会写到技能库外', async () => {
    const { root, workspace, service } = makeHarness()
    const malicious = makeRawZip(join(root, 'evil1.zip'), {
      'SKILL.md': '# Evil\nx',
      '../evil1.txt': 'pwned'
    })
    await expect(service.install(malicious, workspace)).rejects.toThrow(/zip-slip|越界/)
    // 若解压越界会落到 userDir 的父目录（data/evil1.txt）；必须不存在
    expect(existsSync(join(service.userDir, '..', 'evil1.txt'))).toBe(false)
    expect(existsSync(join(root, 'evil1.txt'))).toBe(false)

    const absolute = makeRawZip(join(root, 'evil2.zip'), {
      'SKILL.md': '# Evil\nx',
      '/evil2.txt': 'pwned'
    })
    await expect(service.install(absolute, workspace)).rejects.toThrow(/绝对路径/)
    expect(existsSync(join(service.userDir, 'evil2.txt'))).toBe(false)
    expect(existsSync(join(root, 'evil2.txt'))).toBe(false)
  })
})

/* ── 详情 / 删除 / 状态 ───────────────────────────────────────── */

describe('详情、删除与状态清理', () => {

  it('@core:skills 删除用户技能会移除目录与状态记录；工作区技能不允许删除', async () => {
    const { workspace, service } = makeHarness()
    writeSkill(service.userDir, 'temp', '# Temp\nx')
    writeSkill(join(workspace, 'skills'), 'ws-only', '# Workspace\nx')
    service.setEnabled('user:temp', false, workspace)
    const snapshot = service.remove('user:temp', workspace)
    expect(snapshot.skills.some((skill) => skill.name === 'temp')).toBe(false)
    expect(existsSync(join(service.userDir, 'temp'))).toBe(false)
    const state = JSON.parse(readFileSync(service.stateFile, 'utf8')) as { skills: Record<string, unknown> }
    expect(state.skills['user:temp']).toBeUndefined()

    const wsSkill = snapshot.skills.find((skill) => skill.name === 'ws-only')!
    expect(() => service.remove(wsSkill.id, workspace)).toThrow(/工作区/)
    expect(existsSync(join(workspace, 'skills', 'ws-only', 'SKILL.md'))).toBe(true)
  })
})

/* ── feature:skills:* 处理器 ──────────────────────────────────── */

describe('feature:skills:* 处理器（IPC 契约）', () => {
  async function makeHandlers(): Promise<{
    harness: Harness
    handlers: ReturnType<typeof createSkillsFeatureHandlers>
    effects: {
      revealed: string[]
      openedDir: string[]
      pickZipResult: string | null
      pickFolderResult: string | null
    }
  }> {
    const harness = makeHarness()
    writeSkill(serviceDir(harness), 'skill-a', '# Skill A\n说明。')
    const effects = {
      revealed: [] as string[],
      openedDir: [] as string[],
      pickZipResult: join(harness.root, 'picked.zip') as string | null,
      pickFolderResult: null as string | null
    }
    const handlers = createSkillsFeatureHandlers(harness.service, {
      revealPath: async (path) => {
        effects.revealed.push(path)
      },
      openUserDir: async (path) => {
        effects.openedDir.push(path)
      },
      pickZip: async () => effects.pickZipResult,
      pickFolder: async () => effects.pickFolderResult
    })
    return { harness, handlers, effects }
  }

  function serviceDir(harness: Harness): string {
    return harness.service.userDir
  }

  it('@core:skills install / remove / rescan 频道可用，参数缺失给出可读错误', async () => {
    const { harness, handlers } = await makeHandlers()
    const source = writeSkill(join(harness.root, 'downloads'), 'brand-new', '# Brand New\n新技能。')
    const installed = (await handlers['feature:skills:install']({
      sourcePath: source,
      workspace: harness.workspace
    })) as { installed: { id: string; name: string }; snapshot: { skills: unknown[] } }
    expect(installed.installed.name).toBe('brand-new')

    const removed = (await handlers['feature:skills:remove']({
      id: installed.installed.id,
      workspace: harness.workspace
    })) as { skills: Array<{ name: string }> }
    expect(removed.skills.some((skill) => skill.name === 'brand-new')).toBe(false)

    const rescanned = (await handlers['feature:skills:rescan']({ workspace: harness.workspace })) as {
      skills: unknown[]
    }
    expect(Array.isArray(rescanned.skills)).toBe(true)

    await expect(handlers['feature:skills:read']({})).rejects.toThrow(/id/)
    await expect(handlers['feature:skills:setEnabled']({ id: 'user:x' })).rejects.toThrow(/enabled/)
    await expect(handlers['feature:skills:install']({ sourcePath: '  ' })).rejects.toThrow(/sourcePath/)
    await expect(handlers['feature:skills:list']('bad')).rejects.toThrow(/参数格式/)
  })
})
})

describe('session-export.test.ts', () => {
function session(): Session {
  return {
    id: 's_export_test',
    title: '导出测试',
    workspace: 'C:\\ws',
    model: { providerId: 'p', modelId: 'm' },
    permissionMode: 'ask',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messageCount: 3,
    usage: { inputTokens: 10, outputTokens: 20 },
    todos: [{ id: 't1', text: '第一步', status: 'completed' }],
    artifacts: [{ id: 'a1', title: '报告', kind: 'markdown', content: '# x', createdAt: 1, updatedAt: 1 }],
    messages: [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: '请写报告' }], displayText: '请写报告', createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: '好的，已经写好。' },
          {
            type: 'tool_use',
            id: 'c1',
            name: 'write_file',
            title: '写入报告',
            category: 'write',
            input: { path: 'out.md' },
            status: 'success',
            result: { ok: true, output: '已写入 out.md' }
          }
        ],
        createdAt: 2
      }
    ]
  }
}

describe('session export', () => {
  it('@core:artifacts renders markdown with messages, tools, todos and artifacts', () => {
    const markdown = sessionToMarkdown(session())
    expect(markdown).toContain('# 导出测试')
    expect(markdown).toContain('请写报告')
    expect(markdown).toContain('好的，已经写好。')
    expect(markdown).toContain('write_file')
    expect(markdown).toContain('- [x] 第一步')
    expect(markdown).toContain('报告')
  })
})
})

describe('reveal.test.ts', () => {
const tempDirs: string[] = []
const servers: Server[] = []

function tempFile(name = '报告 1.html'): string {
  const dir = mkdtempSync(join(tmpdir(), 'morrow-reveal-'))
  tempDirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, 'x', 'utf8')
  return path
}

async function servePipe(pipe: string, response: string, onRequest?: (line: string) => void): Promise<void> {
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      onRequest?.(buffer.trim())
      socket.end(`${response}\n`)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(`\\\\.\\pipe\\${pipe}`, resolve))
}

function usePipe(): string {
  const pipe = `morrow-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  process.env.MORROW_LAUNCHER_PIPE = pipe
  return pipe
}

afterEach(async () => {
  delete process.env.MORROW_LAUNCHER_PIPE
  openPathMock.mockReset()
  openPathMock.mockResolvedValue('')
  showItemMock.mockReset()
  while (servers.length > 0) {
    const server = servers.pop()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('reveal in file manager', () => {
  it('@core:artifacts 打包版优先走启动器代理并传递目标', async () => {
    if (process.platform !== 'win32') return
    const path = tempFile()
    const pipe = usePipe()
    let request = ''
    await servePipe(pipe, 'OK', (line) => { request = line })
    await expect(revealInFileManager(path)).resolves.toBeNull()
    const [command, encoded] = request.split(' ')
    expect(command).toBe('REVEAL')
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(path)
    expect(showItemMock).not.toHaveBeenCalled()
  })

  it('@core:artifacts 代理失败时返回原因，不偷偷回退到 ShellExecute', async () => {
    if (process.platform !== 'win32') return
    const path = tempFile()
    const pipe = usePipe()
    await servePipe(pipe, 'ERR\t系统文件管理器未能打开目标')
    await expect(openPathFromUserShell(path)).resolves.toBe('系统文件管理器未能打开目标')
    expect(openPathMock).not.toHaveBeenCalled()
  })
})
})
