/**
 * 合并后的 reveal 组：Agent 规则、内置技能、自定义命令/集群成员、权限规则、技能库、会话导出、文件管理器定位。
 * 每个原文件各自包在 describe('<原文件名>') 中；本文件 mock 子进程，因此不包含依赖真实命令的用例。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { discoverAgentRules } from '../../../src/main/services/agent-rules'
import { makeTempDir, makeTempWorkspace } from '../core/helpers/workspace'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { scanUserSkills, discoverSkills, SKILLS_STATE_FILE_ENV, USER_SKILLS_DIR_ENV } from '../../../src/core/tools/skills'
import { BUILTIN_SKILLS, ensureBuiltinSkills } from '../../../src/main/services/builtin-skills'
import { expandCustomCommand } from '../../../src/shared/commands'
import { discoverCustomCommands, parseCommandFile } from '../../../src/main/services/command-service'
import { BUILTIN_AGENT_ROLES } from '../../../src/core/agent-roles'
import { loadAgentRoles, parseAgentFile, summarizeAgentRoles } from '../../../src/main/services/custom-agents'
import { PermissionRulesService } from '../../../src/main/services/permission-rules'
import { evaluatePermission, permissionRuleMatches, type PermissionPolicyContext, type PermissionTarget } from '../../../src/core/permissions'
import JSZip from 'jszip'
import { createSkillsFeatureHandlers, createSkillsService, installSkillsRuntimeEnv, normalizeArchivePath, sanitizeSkillDirName, SkillsService } from '../../../src/main/services/skills-service'
import { sessionExportContent, sessionToMarkdown } from '../../../src/main/services/session-export'
import { type Session } from '../../../src/shared/types'
import { createServer, type Server } from 'node:net'
import { openPathFromUserShell, revealInFileManager } from '../../../src/main/services/reveal'

const electronState = vi.hoisted(() => ({ dataDir: '' }))
const spawnMock = vi.hoisted(() => vi.fn())
const openPathMock = vi.hoisted(() => vi.fn(async () => ''))
const showItemMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
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
  it('discovers project, parent and user rules in priority order', () => {
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

  it('truncates rules that exceed the token budget', () => {
    const root = temp()
    const workspace = join(root, 'repo')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'AGENTS.md'), 'A'.repeat(20_000), 'utf8')
    const discovery = discoverAgentRules(workspace, { homeDir: join(root, 'home'), maxTokens: 300 })
    expect(discovery.truncated).toBe(true)
    expect(discovery.usedTokens).toBeLessThanOrEqual(discovery.limitTokens)
    expect(discovery.files[0].truncated).toBe(true)
    expect(discovery.text).toContain('已按规则预算截断')
  })

  it('returns empty text when no rule files exist', () => {
    const root = temp()
    expect(discoverAgentRules(root, { homeDir: join(root, 'home') }).text).toBe('')
  })

  it('discovers MORROW.md in .morrow, parent and user scopes in priority order', () => {
    const root = temp()
    const workspace = join(root, 'repo')
    const home = join(root, 'home')
    mkdirSync(join(workspace, '.morrow'), { recursive: true })
    mkdirSync(join(home, '.morrow'), { recursive: true })
    writeFileSync(join(workspace, '.morrow', 'MORROW.md'), 'DOT-MORROW', 'utf8')
    writeFileSync(join(workspace, 'AGENTS.md'), 'ROOT-AGENTS', 'utf8')
    writeFileSync(join(root, 'MORROW.md'), 'PARENT-MORROW', 'utf8')
    writeFileSync(join(home, '.morrow', 'MORROW.md'), 'USER-MORROW', 'utf8')

    const discovery = discoverAgentRules(workspace, { homeDir: home })
    const order = ['DOT-MORROW', 'ROOT-AGENTS', 'PARENT-MORROW', 'USER-MORROW'].map((marker) =>
      discovery.text.indexOf(marker)
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('skips binary rule files instead of injecting replacement characters', () => {
    const root = temp()
    const workspace = join(root, 'repo')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'AGENTS.md'), Buffer.from([0x41, 0x00, 0x42, 0x43]))
    const discovery = discoverAgentRules(workspace, { homeDir: join(root, 'home') })
    expect(discovery.files).toHaveLength(0)
    expect(discovery.text).toBe('')
  })

  it('does not follow rule symlinks outside the workspace', () => {
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
  it('首次启动安装全部内置技能，并能被 core 发现与解析描述', () => {
    const dataDir = tempDir()
    const changed = ensureBuiltinSkills(dataDir)
    expect(changed.sort()).toEqual(BUILTIN_SKILLS.map((skill) => skill.name).sort())
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(18)
    for (const skill of BUILTIN_SKILLS) {
      const path = join(dataDir, 'skills', skill.name, 'SKILL.md')
      expect(existsSync(path)).toBe(true)
      const content = readFileSync(path, 'utf8')
      expect(content).toContain(`name: ${skill.name}`)
      expect(content).toContain('## 何时使用')
      expect(content.length).toBeGreaterThan(1500)
      expect(content).not.toMatch(/\b(?:1080p|1440|1920|2560|3840)\b/)
      expect(content).not.toMatch(/\b\d{3,4}\s*px\b/)
    }
    const discovered = scanUserSkills(join(dataDir, 'skills'))
    expect(discovered.map((skill) => skill.name).sort()).toEqual(BUILTIN_SKILLS.map((skill) => skill.name).sort())
    for (const skill of discovered) expect(skill.description.length).toBeGreaterThan(40)
    const art = discovered.find((skill) => skill.name === 'frontend-art-direction')
    expect(art).toBeTruthy()
    expect(readFileSync(art!.skillPath, 'utf8')).toContain('视觉简报')
    const quality = discovered.find((skill) => skill.name === 'deliverable-quality')
    expect(quality).toBeTruthy()
    expect(readFileSync(quality!.skillPath, 'utf8')).toContain('跨类型交付质量门槛')
    for (const name of ['brainstorm-and-scope', 'plan-and-execute', 'verify-before-delivery', 'parallel-work', 'canvas-artifacts', 'workspace-git', 'skill-author']) {
      expect(discovered.some((skill) => skill.name === name), name).toBe(true)
    }
    // parallel-work 只讲协作方法，成员分工以角色为准，二者不互相改写
    const parallel = readFileSync(join(dataDir, 'skills', 'parallel-work', 'SKILL.md'), 'utf8')
    expect(parallel).toContain('角色与技能：分工和方法分开')
    expect(parallel).toContain('技能不能改变分工、权限、交付对象或验收标准')
    expect(parallel).toContain('architect')
    expect(parallel).not.toContain('general/explore/plan/review/test/docs 或自定义类型')
  })

  it('旧版未修改的内置技能会随版本升级更新，用户改过的保留', () => {
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

  it('已合并的旧技能在升级时移除，用户改过的保留为自有技能', () => {
    const dataDir = tempDir()
    ensureBuiltinSkills(dataDir)
    const markerPath = join(dataDir, 'skills', '.builtin-skills.json')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      version: number
      skills: Record<string, { hash: string; modified?: boolean }>
    }
    for (const [name, body] of [
      ['docs-writer', '旧文档技能'],
      ['deliverable-report', '旧报告技能'],
      ['release-notes', '旧发布说明技能']
    ]) {
      const dir = join(dataDir, 'skills', name)
      mkdirSync(dir, { recursive: true })
      const content = `---\nname: ${name}\ndescription: 旧内置技能\n---\n${body}\n`
      writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
      marker.skills[name] = { hash: createHash('sha256').update(content).digest('hex') }
    }
    writeFileSync(markerPath, JSON.stringify(marker), 'utf8')

    const changed = ensureBuiltinSkills(dataDir)
    for (const name of ['docs-writer', 'deliverable-report', 'release-notes']) {
      expect(changed).toContain(name)
      expect(existsSync(join(dataDir, 'skills', name))).toBe(false)
    }

    // 用户改过的旧技能不删除，但不再作为内置技能管理
    const editedDir = join(dataDir, 'skills', 'docs-writer')
    mkdirSync(editedDir, { recursive: true })
    const edited = '---\nname: docs-writer\ndescription: 我改过的\n---\n保留我\n'
    writeFileSync(join(editedDir, 'SKILL.md'), edited, 'utf8')
    const nextMarker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      version: number
      skills: Record<string, { hash: string; modified?: boolean }>
    }
    nextMarker.skills['docs-writer'] = { hash: createHash('sha256').update('旧内容').digest('hex') }
    writeFileSync(markerPath, JSON.stringify(nextMarker), 'utf8')
    ensureBuiltinSkills(dataDir)
    expect(readFileSync(join(editedDir, 'SKILL.md'), 'utf8')).toContain('保留我')
    const after = JSON.parse(readFileSync(markerPath, 'utf8')) as { skills: Record<string, unknown> }
    expect(after.skills['docs-writer']).toBeUndefined()
  })

  it('不覆盖用户编辑，也不恢复用户删除的技能', () => {
    const dataDir = tempDir()
    ensureBuiltinSkills(dataDir)
    const editedPath = join(dataDir, 'skills', 'code-review', 'SKILL.md')
    writeFileSync(editedPath, '---\nname: code-review\ndescription: 用户改过的\n---\n保留我\n', 'utf8')
    rmSync(join(dataDir, 'skills', 'debugging'), { recursive: true, force: true })

    const changed = ensureBuiltinSkills(dataDir)
    expect(changed).not.toContain('code-review')
    expect(readFileSync(editedPath, 'utf8')).toContain('保留我')
    expect(existsSync(join(dataDir, 'skills', 'debugging', 'SKILL.md'))).toBe(false)

    // 再次启动也必须保留用户编辑（旧实现第二次启动会用内置内容覆盖）
    const changedAgain = ensureBuiltinSkills(dataDir)
    expect(changedAgain).not.toContain('code-review')
    expect(readFileSync(editedPath, 'utf8')).toContain('保留我')
  })

  it('已并入 frontend-art-direction 的旧技能 ui-polish 会在升级时移除，用户改过的保留', () => {
    const dataDir = tempDir()
    ensureBuiltinSkills(dataDir)
    const markerPath = join(dataDir, 'skills', '.builtin-skills.json')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      version: number
      skills: Record<string, { hash: string; modified?: boolean }>
    }
    const retiredDir = join(dataDir, 'skills', 'ui-polish')
    mkdirSync(retiredDir, { recursive: true })
    const original = '---\nname: ui-polish\ndescription: 旧内置技能\n---\n旧内容\n'
    writeFileSync(join(retiredDir, 'SKILL.md'), original, 'utf8')
    marker.skills['ui-polish'] = { hash: createHash('sha256').update(original).digest('hex') }
    writeFileSync(markerPath, JSON.stringify(marker), 'utf8')

    const changed = ensureBuiltinSkills(dataDir)
    expect(changed).toContain('ui-polish')
    expect(existsSync(retiredDir)).toBe(false)

    // 用户改过的旧技能不被删除，而是转为用户自有技能
    mkdirSync(retiredDir, { recursive: true })
    const edited = '---\nname: ui-polish\ndescription: 我改过的\n---\n保留我\n'
    writeFileSync(join(retiredDir, 'SKILL.md'), edited, 'utf8')
    const nextMarker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      version: number
      skills: Record<string, { hash: string; modified?: boolean }>
    }
    nextMarker.skills['ui-polish'] = { hash: createHash('sha256').update(original).digest('hex') }
    writeFileSync(markerPath, JSON.stringify(nextMarker), 'utf8')
    ensureBuiltinSkills(dataDir)
    expect(readFileSync(join(retiredDir, 'SKILL.md'), 'utf8')).toContain('保留我')
    const after = JSON.parse(readFileSync(markerPath, 'utf8')) as { skills: Record<string, unknown> }
    expect(after.skills['ui-polish']).toBeUndefined()
  })

  it('同名用户技能已存在时不覆盖', () => {
    const dataDir = tempDir()
    const dir = join(dataDir, 'skills', 'code-review')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: code-review\ndescription: 我自己的审查流程\n---\n自己的内容\n', 'utf8')
    ensureBuiltinSkills(dataDir)
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('自己的内容')
  })
})
})

describe('command-service.test.ts', () => {
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

describe('自定义命令发现', () => {
  it('解析 frontmatter、参数提示与正文；无描述时取正文第一行', () => {
    const withMeta = parseCommandFile(
      `---\ndescription: "生成发布说明"\nargument-hint: 版本号\n---\n\n请为 $1 写发布说明。\n`,
      'release',
      'project',
      'C:/repo/.morrow/commands/release.md'
    )
    expect(withMeta).toMatchObject({
      name: 'release',
      description: '生成发布说明',
      argumentHint: '版本号',
      scope: 'project',
      body: '请为 $1 写发布说明。'
    })
    const withoutMeta = parseCommandFile('# 代码审查\n\n检查 $ARGUMENTS', 'review', 'user', 'x.md')
    expect(withoutMeta?.description).toBe('代码审查')
    expect(parseCommandFile('---\ndescription: 空\n---\n', 'empty', 'user', 'x.md')).toBeNull()
  })

  it('项目命令覆盖同名用户命令，非法文件名与非 Markdown 被忽略', () => {
    const home = tempDir('morrow-cmd-home-')
    const workspace = tempDir('morrow-cmd-ws-')
    mkdirSync(join(home, '.morrow', 'commands'), { recursive: true })
    mkdirSync(join(workspace, '.morrow', 'commands'), { recursive: true })
    writeFileSync(join(home, '.morrow', 'commands', 'deploy.md'), '用户级部署 $ARGUMENTS\n', 'utf8')
    writeFileSync(join(home, '.morrow', 'commands', 'notes.txt'), '忽略\n', 'utf8')
    writeFileSync(join(home, '.morrow', 'commands', 'bad name.md'), '忽略\n', 'utf8')
    writeFileSync(join(workspace, '.morrow', 'commands', 'deploy.md'), '项目级部署 $ARGUMENTS\n', 'utf8')
    writeFileSync(join(workspace, '.morrow', 'commands', 'review.md'), '审查 $1\n', 'utf8')

    const commands = discoverCustomCommands(workspace, home)
    expect(commands.map((command) => command.name)).toEqual(['deploy', 'review'])
    expect(commands.find((command) => command.name === 'deploy')?.scope).toBe('project')
    expect(commands.find((command) => command.name === 'deploy')?.body).toContain('项目级')
  })

  it('拒绝通过链接到工作区外的 .morrow 读取项目命令', () => {
    const home = tempDir('morrow-cmd-link-home-')
    const workspace = tempDir('morrow-cmd-link-ws-')
    const outside = tempDir('morrow-cmd-link-out-')
    mkdirSync(join(outside, 'commands'), { recursive: true })
    writeFileSync(join(outside, 'commands', 'leak.md'), '工作区外命令\n', 'utf8')
    symlinkSync(outside, join(workspace, '.morrow'), 'junction')

    expect(discoverCustomCommands(workspace, home)).toHaveLength(0)
  })

  it('达到 100 条上限后，项目命令仍可覆盖同名用户命令', () => {
    const home = tempDir('morrow-cmd-cap-home-')
    const workspace = tempDir('morrow-cmd-cap-ws-')
    const homeDir = join(home, '.morrow', 'commands')
    const projectDir = join(workspace, '.morrow', 'commands')
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    for (let index = 0; index < 100; index += 1) {
      const name = index === 0 ? 'review' : `cmd-${String(index).padStart(3, '0')}`
      writeFileSync(join(homeDir, `${name}.md`), `用户级 ${name}\n`, 'utf8')
    }
    writeFileSync(join(projectDir, 'review.md'), '项目级覆盖\n', 'utf8')
    writeFileSync(join(projectDir, 'extra.md'), '超出上限\n', 'utf8')

    const commands = discoverCustomCommands(workspace, home)
    expect(commands).toHaveLength(100)
    expect(commands.find((command) => command.name === 'review')?.body).toBe('项目级覆盖')
    expect(commands.some((command) => command.name === 'extra')).toBe(false)
  })

  it('展开模板：$ARGUMENTS、位置参数与无占位符时追加参数', () => {
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
  it('解析 frontmatter：标题与提示；工具/只读字段不再限制权限', () => {
    const role = parseAgentFile(
      `---
title: 安全审计
description: 只读审计安全边界
tools: read_file, grep, glob
read-only: true
---
你只检查安全问题。`,
      'security',
      'project',
      'x.md'
    )
    expect(role).toMatchObject({
      name: 'security',
      title: '安全审计',
      description: '只读审计安全边界',
      source: 'project'
    })
    expect(role?.systemPrompt).toContain('只检查安全问题')
    expect(parseAgentFile('---\ntitle: 空\n---\n', 'empty', 'user', 'x.md')).toBeNull()

    // 旧 frontmatter 的 tools/read-only 字段被忽略：成员始终拥有与主代理相同的完整权限
    const legacy = parseAgentFile('---\ntools: Read_File, read_file, GREP\nread-only: true\n---\n只分析。', 'legacy-role', 'user', 'x.md')
    expect(legacy).not.toHaveProperty('tools')
    expect(legacy).not.toHaveProperty('readOnly')
  })

  it('达到 32 个角色上限后，项目角色仍可覆盖同名用户角色', () => {
    const home = tempDir('morrow-agents-cap-home-')
    const workspace = tempDir('morrow-agents-cap-ws-')
    const homeDir = join(home, '.morrow', 'agents')
    const projectDir = join(workspace, '.morrow', 'agents')
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    for (let index = 0; index < 32; index += 1) {
      const name = index === 0 ? 'audit' : `role-${String(index).padStart(3, '0')}`
      writeFileSync(join(homeDir, `${name}.md`), `用户级 ${name}\n`, 'utf8')
    }
    writeFileSync(join(projectDir, 'audit.md'), '项目级覆盖\n', 'utf8')
    writeFileSync(join(projectDir, 'extra.md'), '超出上限\n', 'utf8')

    const roles = loadAgentRoles(workspace, home)
    const custom = roles.filter((role) => role.source !== 'builtin')
    expect(custom).toHaveLength(32)
    expect(custom.find((role) => role.name === 'audit')?.systemPrompt).toContain('项目级')
    expect(roles.some((role) => role.name === 'extra')).toBe(false)
  })

  it('拒绝通过链接到工作区外的 .morrow 读取项目角色', () => {
    const home = tempDir('morrow-agents-link-home-')
    const workspace = tempDir('morrow-agents-link-ws-')
    const outside = tempDir('morrow-agents-link-out-')
    mkdirSync(join(outside, 'agents'), { recursive: true })
    writeFileSync(join(outside, 'agents', 'leak.md'), '工作区外角色\n', 'utf8')
    symlinkSync(outside, join(workspace, '.morrow'), 'junction')

    const roles = loadAgentRoles(workspace, home)
    expect(roles.filter((role) => role.source !== 'builtin')).toHaveLength(0)
  })

  it('内置角色始终存在；项目角色覆盖同名用户角色；内置名不可覆盖', () => {
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

function service(): PermissionRulesService {
  const dir = makeTempDir('morrow-perm-')
  dirs.push(dir)
  return new PermissionRulesService(dir)
}

function target(toolName: string, category: PermissionTarget['category'], input: Record<string, unknown>): PermissionTarget {
  return { toolName, category, baseRisk: category === 'read' ? 'low' : 'medium', input, title: toolName }
}

function policy(workspace: string, rules: ReturnType<PermissionRulesService['list']>): PermissionPolicyContext {
  return { mode: 'ask', workspace, isDemo: false, sessionGrants: new Set(), workspaceRules: rules }
}

describe('PermissionRulesService', () => {
  it('persists workspace rules and logs approvals', () => {
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

  it('stores whole-tool rules without a pattern and dedupes identical rules', () => {
    const rules = service()
    const ws = makeTempWorkspace()
    try {
      const first = rules.add({
        workspace: ws.root,
        tool: 'run_command',
        kind: 'tool',
        pattern: 'ignored',
        decision: 'allow'
      })
      expect(first.pattern).toBe('')
      const again = rules.add({
        workspace: ws.root,
        tool: 'run_command',
        kind: 'tool',
        pattern: '',
        decision: 'allow'
      })
      expect(again.id).toBe(first.id)
      expect(rules.list(ws.root)).toHaveLength(1)
    } finally {
      ws.cleanup()
    }
  })

  it('canonicalizes symlinked workspace paths so UI and runtime see the same rules', () => {
    const rules = service()
    const ws = makeTempWorkspace()
    const base = makeTempDir('morrow-perm-link-')
    dirs.push(base)
    const link = join(base, 'ws-link')
    try {
      symlinkSync(ws.root, link, process.platform === 'win32' ? 'junction' : 'dir')
      const created = rules.add({
        workspace: link,
        tool: 'write_file',
        kind: 'path',
        pattern: 'out',
        decision: 'allow'
      })
      expect(rules.list(ws.root).map((rule) => rule.id)).toContain(created.id)
    } finally {
      ws.cleanup()
    }
  })

  it('scopes rule deletion to the requesting workspace', () => {
    const rules = service()
    const a = makeTempWorkspace()
    const b = makeTempWorkspace()
    try {
      const rule = rules.add({
        workspace: a.root,
        tool: 'run_command',
        kind: 'prefix',
        pattern: 'npm test',
        decision: 'allow'
      })
      expect(rules.remove(rule.id, b.root)).toBe(false)
      expect(rules.list(a.root)).toHaveLength(1)
      expect(rules.remove(rule.id, a.root)).toBe(true)
      expect(rules.list(a.root)).toHaveLength(0)
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  it('persists edit_docx always-allow rules against the output path', () => {
    const rules = service()
    const ws = makeTempWorkspace()
    try {
      const rule = rules.addAlwaysRule({
        workspace: ws.root,
        tool: 'edit_docx',
        toolInput: { path: 'templates/in.docx', output_path: 'out/final.docx' }
      })
      expect(rule?.pattern).toBe('out/final.docx')
      const ctx = policy(ws.root, rules.list(ws.root))
      const edit = target('edit_docx', 'write', { path: 'templates/in.docx', output_path: 'out/final.docx' })
      expect(permissionRuleMatches(rule!, edit, ctx)).toBe(true)
    } finally {
      ws.cleanup()
    }
  })

  it('backs up a corrupt rules file instead of silently overwriting it', () => {
    const dir = makeTempDir('morrow-perm-corrupt-')
    dirs.push(dir)
    const ws = makeTempWorkspace()
    try {
      writeFileSync(join(dir, 'permissions.json'), '{not json', 'utf8')
      const rules = new PermissionRulesService(dir)
      expect(rules.list(ws.root)).toEqual([])
      expect(readdirSync(dir).some((name) => name.startsWith('permissions.json.corrupt-'))).toBe(true)
    } finally {
      ws.cleanup()
    }
  })
})

describe('permission rules in evaluatePermission', () => {
  it('allows matching command prefixes and denies deny rules with higher priority', () => {
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

  it('allows path prefixes but never overrides dangerous commands or external actions', () => {
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

/* ── 纯函数校验 ───────────────────────────────────────────────── */

describe('安装路径/名称校验（纯函数）', () => {
  it('normalizeArchivePath 拒绝 zip-slip 与绝对路径，接受正常嵌套路径', () => {
    expect(normalizeArchivePath('release/SKILL.md')).toBe('release/SKILL.md')
    expect(normalizeArchivePath('release\\scripts\\notes.md')).toBe('release/scripts/notes.md')
    expect(normalizeArchivePath('release/')).toBeNull()
    expect(() => normalizeArchivePath('../evil.txt')).toThrow(/zip-slip|越界/)
    expect(() => normalizeArchivePath('a/../../evil.txt')).toThrow(/zip-slip|越界/)
    expect(() => normalizeArchivePath('/etc/evil.txt')).toThrow(/绝对路径/)
    expect(() => normalizeArchivePath('C:\\evil.txt')).toThrow(/绝对路径/)
    expect(() => normalizeArchivePath('a/bad:name.md')).toThrow(/非法文件名/)
    expect(() => normalizeArchivePath('a/trailingdot./x.md')).toThrow(/非法文件名/)
  })

  it('sanitizeSkillDirName 去掉路径分隔符/非法字符、避开 Windows 保留名', () => {
    expect(sanitizeSkillDirName('release')).toBe('release')
    expect(sanitizeSkillDirName('a/b\\c')).toBe('a-b-c')
    expect(sanitizeSkillDirName('CON')).toBe('skill-CON')
    expect(sanitizeSkillDirName('  ..  ')).toBe('skill')
    expect(sanitizeSkillDirName('x'.repeat(80))).toHaveLength(64)
  })
})

/* ── 发现与列表 ───────────────────────────────────────────────── */

describe('技能发现与列表', () => {
  it('同时发现工作区技能与用户技能库，并标记来源/启用状态/文件数', () => {
    const { root, workspace, service } = makeHarness()
    writeSkill(join(workspace, '.morrow', 'skills'), 'release', '# Release\n按 changelog 发版。', {
      'checklist.md': '- step 1\n'
    })
    writeSkill(service.userDir, 'summarize', '# Summarize\n把长文压缩成三行。', {
      'assets/template.md': '模板'
    })
    const snapshot = service.list(workspace)
    expect(snapshot.skills).toHaveLength(2)
    const release = snapshot.skills.find((skill) => skill.name === 'release')!
    expect(release.source).toBe('workspace')
    expect(release.enabled).toBe(true)
    expect(release.id.startsWith('workspace:')).toBe(true)
    expect(release.displayDir).toBe('.morrow/skills/release')
    const summarize = snapshot.skills.find((skill) => skill.name === 'summarize')!
    expect(summarize.source).toBe('user')
    expect(summarize.enabled).toBe(true)
    expect(summarize.id).toBe('user:summarize')
    expect(summarize.fileCount).toBe(2)
    expect(summarize.resources).toContain('assets/')
    expect(summarize.description).toContain('把长文压缩成三行')
    expect(snapshot.errors).toEqual([])
  })

  it('没有工作区时只列出用户技能库；不完整目录进入 errors 而不是技能列表', () => {
    const { service } = makeHarness()
    writeSkill(service.userDir, 'alone', '# Alone\n只读技能。')
    mkdirSync(join(service.userDir, 'broken'), { recursive: true })
    writeFileSync(join(service.userDir, 'broken', 'notes.md'), 'missing skill.md')
    const snapshot = service.list(null)
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(['alone'])
    expect(snapshot.errors.some((message) => message.includes('broken'))).toBe(true)
  })

  it('同名技能：工作区优先给 Agent 使用，用户技能仍列出并标记 shadowed', () => {
    const { workspace, service } = makeHarness()
    writeSkill(join(workspace, 'skills'), 'release', '# Workspace release\n工作区版本。')
    writeSkill(service.userDir, 'release', '# User release\n技能库版本。')
    service.installRuntimeEnv()
    try {
      const snapshot = service.list(workspace)
      const userEntry = snapshot.skills.find((skill) => skill.source === 'user')!
      expect(userEntry.shadowed).toBe(true)
      const visible = discoverSkills(workspace)
      expect(visible).toHaveLength(1)
      expect(visible[0].source).toBe('workspace')
      expect(visible[0].description).toContain('工作区版本')
    } finally {
      delete process.env[USER_SKILLS_DIR_ENV]
      delete process.env[SKILLS_STATE_FILE_ENV]
    }
  })
})

/* ── 启停 ─────────────────────────────────────────────────────── */

describe('启用 / 禁用（Agent 侧立即生效）', () => {
  it('禁用用户技能后，core 的 discoverSkills 过滤掉它；重新启用恢复', () => {
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

  it('工作区技能也能被禁用（状态按绝对目录记录，不写工作区文件）', () => {
    const { workspace, service } = makeHarness()
    const dir = writeSkill(join(workspace, '.morrow', 'skills'), 'audit', '# Audit\n审计流程。')
    installSkillsRuntimeEnv(service)
    try {
      const target = service.list(workspace).skills.find((skill) => skill.name === 'audit')!
      service.setEnabled(target.id, false, workspace)
      expect(discoverSkills(workspace)).toEqual([])
      // 只写数据目录状态文件，不动工作区
      expect(existsSync(join(service.userDir))).toBe(true)
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('审计流程')
    } finally {
      delete process.env[USER_SKILLS_DIR_ENV]
      delete process.env[SKILLS_STATE_FILE_ENV]
    }
  })

  it('非法 id / 非法 enabled 参数报错', () => {
    const { workspace, service } = makeHarness()
    writeSkill(service.userDir, 'x', '# X\nx')
    expect(() => service.setEnabled('user:nope', false, workspace)).toThrow(/没有找到技能/)
    expect(() => service.setEnabled('user:x', 'yes' as unknown as boolean, workspace)).toThrow(/布尔/)
  })
})

/* ── 文件夹安装 ───────────────────────────────────────────────── */

describe('从本地文件夹安装', () => {
  it('复制技能到用户技能库，SKILL.md 大小写归一、默认启用、记录 installedAt/origin', async () => {
    const { root, workspace, service } = makeHarness()
    const source = writeSkill(join(root, 'downloads'), 'my-skill', '---\ndescription: 演示技能\n---\n# My skill\n步骤。', {
      'assets/template.md': '模板内容'
    })
    // python 类工具可能写出小写 skill.md；服务应归一成 SKILL.md
    rmSync(join(source, 'SKILL.md'))
    writeFileSync(join(source, 'skill.md'), '---\ndescription: 演示技能\n---\n# My skill\n步骤。', 'utf8')

    const result = await service.install(source, workspace)
    expect(result.installed).toMatchObject({ name: 'my-skill', source: 'user', enabled: true })
    expect(result.installed.installedAt).toBeTypeOf('number')
    expect(existsSync(join(service.userDir, 'my-skill', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(service.userDir, 'my-skill', 'assets', 'template.md'), 'utf8')).toBe('模板内容')
    const snapshot = service.list(workspace)
    expect(snapshot.skills.find((skill) => skill.name === 'my-skill')?.enabled).toBe(true)
    // 安装目录不含暂存目录残留
    expect(snapshot.skills.every((skill) => !skill.name.startsWith('.staging'))).toBe(true)
  })

  it('缺少 SKILL.md / 空目录 / 相对路径 / 不存在路径都给出可读错误', async () => {
    const { root, workspace, service } = makeHarness()
    const noSkill = join(root, 'downloads', 'no-skill')
    mkdirSync(noSkill, { recursive: true })
    writeFileSync(join(noSkill, 'readme.md'), 'no skill')
    await expect(service.install(noSkill, workspace)).rejects.toThrow(/缺少 SKILL\.md/)

    const empty = join(root, 'downloads', 'empty')
    mkdirSync(empty, { recursive: true })
    await expect(service.install(empty, workspace)).rejects.toThrow(/没有可安装的文件/)

    await expect(service.install('relative/folder', workspace)).rejects.toThrow(/绝对路径/)
    await expect(service.install(join(root, 'nope'), workspace)).rejects.toThrow(/路径不存在/)
  })

  it('文件夹里的可执行/脚本文件被跳过并报告，资源正常安装', async () => {
    const { root, workspace, service } = makeHarness()
    const withScript = writeSkill(join(root, 'downloads'), 'scripted', '# Scripted\n步骤。', {
      'notes/guide.md': '指南'
    })
    writeFileSync(join(withScript, 'run.js'), 'console.log(1)')
    const result = await service.install(withScript, workspace)
    expect(result.skipped).toEqual(['run.js'])
    expect(existsSync(join(service.userDir, 'scripted', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(service.userDir, 'scripted', 'notes', 'guide.md'))).toBe(true)
    expect(existsSync(join(service.userDir, 'scripted', 'run.js'))).toBe(false)

    const withExe = writeSkill(join(root, 'downloads'), 'exe', '# Exe\n步骤。')
    writeFileSync(join(withExe, 'tool.exe'), 'MZ')
    const exeResult = await service.install(withExe, workspace)
    expect(exeResult.skipped).toEqual(['tool.exe'])
    expect(existsSync(join(service.userDir, 'exe', 'tool.exe'))).toBe(false)
  })

  it('同名技能默认拒绝安装，overwrite=true 时覆盖', async () => {
    const { root, workspace, service } = makeHarness()
    const first = writeSkill(join(root, 'downloads'), 'dup', '# Dup\n第一版。')
    await service.install(first, workspace)
    const second = writeSkill(join(root, 'downloads2'), 'dup2', '# Dup\n第二版。')
    // 目录名不同但 frontmatter name 相同 → 目标同名
    writeFileSync(join(second, 'SKILL.md'), '---\nname: dup\n---\n# Dup\n第二版。', 'utf8')
    await expect(service.install(second, workspace)).rejects.toThrow(/同名技能/)
    const result = await service.install(second, workspace, { overwrite: true })
    expect(result.installed.name).toBe('dup')
    expect(readFileSync(join(service.userDir, 'dup', 'SKILL.md'), 'utf8')).toContain('第二版')
  })
})

/* ── zip 安装 ─────────────────────────────────────────────────── */

describe('从 .zip 安装', () => {
  it('正常 zip（带单层包装目录）解压安装，英文/中文内容与资源都在', async () => {
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

  it('zip-slip（../、绝对路径）被拒绝，且不会写到技能库外', async () => {
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

  it('zip 内可执行文件被跳过；超大文件、文件数超限仍拒绝', async () => {
    const { root, workspace, service } = makeHarness()
    const withExe = await makeZip(join(root, 'exe.zip'), {
      'SKILL.md': '# Exe\nx',
      'bin/payload.exe': 'MZ',
      'notes.md': '正常资源'
    })
    const exeResult = await service.install(withExe, workspace)
    expect(exeResult.skipped).toEqual(['bin/payload.exe'])
    expect(existsSync(join(service.userDir, 'exe', 'bin', 'payload.exe'))).toBe(false)
    expect(existsSync(join(service.userDir, 'exe', 'notes.md'))).toBe(true)

    const huge = await makeZip(join(root, 'huge.zip'), {
      'SKILL.md': '# Huge\nx',
      'data/big.txt': 'a'.repeat(5 * 1024 * 1024 + 10)
    })
    await expect(service.install(huge, workspace)).rejects.toThrow(/文件过大|20MB/)

    const entries: Record<string, string> = { 'SKILL.md': '# Many\nx' }
    for (let index = 0; index < 305; index += 1) entries[`notes/${index}.md`] = 'x'
    const many = await makeZip(join(root, 'many.zip'), entries)
    await expect(service.install(many, workspace)).rejects.toThrow(/文件过多/)
    expect(existsSync(join(service.userDir, 'many'))).toBe(false)
  })

  it('损坏的 zip 给出可读错误', async () => {
    const { root, workspace, service } = makeHarness()
    const broken = join(root, 'broken.zip')
    writeFileSync(broken, 'this is not a zip')
    await expect(service.install(broken, workspace)).rejects.toThrow(/无法解析技能包/)
  })
})

/* ── 详情 / 删除 / 状态 ───────────────────────────────────────── */

describe('详情、删除与状态清理', () => {
  it('detail 返回 SKILL.md 原文（含 frontmatter）与文件清单', async () => {
    const { workspace, service } = makeHarness()
    const content = '---\nname: release\ndescription: 发版技能\n---\n# 发版\n1. 读 changelog。'
    writeSkill(service.userDir, 'release', content, { 'assets/template.md': '模板' })
    const list = service.list(workspace)
    const detail = service.detail(list.skills[0].id, workspace)
    expect(detail.raw).toContain('description: 发版技能')
    expect(detail.raw).toContain('# 发版')
    expect(detail.declaredName).toBe('release')
    expect(detail.files.map((file) => file.path).sort()).toEqual(['SKILL.md', 'assets/template.md'])
    expect(() => service.detail('user:missing', workspace)).toThrow(/没有找到技能/)
  })

  it('删除用户技能会移除目录与状态记录；工作区技能不允许删除', async () => {
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

  it('rescan/pruneState 清掉指向不存在用户技能的状态记录', () => {
    const { workspace, service } = makeHarness()
    writeSkill(service.userDir, 'ghost', '# Ghost\nx')
    service.setEnabled('user:ghost', false, workspace)
    rmSync(join(service.userDir, 'ghost'), { recursive: true, force: true })
    expect(service.list(workspace).errors.some((message) => message.includes('ghost'))).toBe(true)
    let snapshot = service.pruneState(workspace)
    expect(snapshot.errors).toEqual([])
    snapshot = service.list(workspace)
    expect(snapshot.errors).toEqual([])
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

  it('list / read / setEnabled / reveal / openUserDir / pickZip / pickFolder 频道可用', async () => {
    const { harness, handlers, effects } = await makeHandlers()
    const list = (await handlers['feature:skills:list']({ workspace: harness.workspace })) as {
      skills: Array<{ id: string; name: string; enabled: boolean }>
    }
    expect(list.skills).toHaveLength(1)
    const id = list.skills[0].id

    const detail = (await handlers['feature:skills:read']({ id, workspace: harness.workspace })) as { raw: string }
    expect(detail.raw).toContain('# Skill A')

    const disabled = (await handlers['feature:skills:setEnabled']({
      id,
      enabled: false,
      workspace: harness.workspace
    })) as { skills: Array<{ enabled: boolean }> }
    expect(disabled.skills[0].enabled).toBe(false)

    await handlers['feature:skills:reveal']({ id, workspace: harness.workspace })
    expect(effects.revealed[0]).toContain('skill-a')
    await handlers['feature:skills:openUserDir']({})
    expect(effects.openedDir[0]).toBe(harness.service.userDir)
    expect(await handlers['feature:skills:pickZip']({})).toEqual({ path: effects.pickZipResult })
    expect(await handlers['feature:skills:pickFolder']({})).toEqual({ path: null })
  })

  it('install / remove / rescan 频道可用，参数缺失给出可读错误', async () => {
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
  it('renders markdown with messages, tools, todos and artifacts', () => {
    const markdown = sessionToMarkdown(session())
    expect(markdown).toContain('# 导出测试')
    expect(markdown).toContain('请写报告')
    expect(markdown).toContain('好的，已经写好。')
    expect(markdown).toContain('write_file')
    expect(markdown).toContain('- [x] 第一步')
    expect(markdown).toContain('报告')
  })

  it('serializes JSON with a safe filename', () => {
    const json = sessionExportContent({ ...session(), title: 'a/b:c' }, 'json')
    expect(json.filename).toMatch(/^a_b_c\.json$/)
    expect(JSON.parse(json.content).id).toBe('s_export_test')
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

function fakeChild(autoExit = true, exitCode = 0): Record<string, unknown> {
  const child: Record<string, unknown> = {}
  child.on = vi.fn((event: string, callback: (code?: number) => void) => {
    if (autoExit && event === 'exit') queueMicrotask(() => callback(exitCode))
    return child
  })
  child.unref = vi.fn(() => child)
  child.kill = vi.fn()
  return child
}

afterEach(async () => {
  delete process.env.MORROW_LAUNCHER_PIPE
  spawnMock.mockReset()
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
  it('没有启动器代理时用现有 Shell 定位，不创建 Explorer 子进程', async () => {
    const path = tempFile()
    spawnMock.mockReturnValue(fakeChild())
    await expect(revealInFileManager(path)).resolves.toBeNull()
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawnMock.mock.calls[0] ?? []
    expect(command).toBe('powershell.exe')
    expect(args).toContain('-EncodedCommand')
    expect(options).toMatchObject({ windowsHide: true })
    expect((options as { env: Record<string, string> }).env).toMatchObject({
      MORROW_SHELL_MODE: 'REVEAL',
      MORROW_SHELL_TARGET: path
    })
    expect(openPathMock).not.toHaveBeenCalled()
    expect(showItemMock).not.toHaveBeenCalled()
  })

  it('Shell 辅助进程失败时返回真实原因，不弹 Explorer 错误框', async () => {
    const path = tempFile()
    spawnMock.mockReturnValue(fakeChild(true, 1))
    await expect(revealInFileManager(path)).resolves.toContain('退出码 1')
    expect(openPathMock).not.toHaveBeenCalled()
    expect(showItemMock).not.toHaveBeenCalled()
  })

  it('启动器代理存在时通过命名管道执行，不依赖 Electron 的 GUI 子进程', async () => {
    if (process.platform !== 'win32') return
    const path = tempFile()
    const pipe = `morrow-test-${process.pid}-${Date.now()}`
    const server = createServer((socket) => {
      socket.setEncoding('utf8')
      socket.once('data', (data: string) => {
        const [command, encoded] = data.trim().split(' ')
        expect(command).toBe('REVEAL')
        expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(path)
        socket.end('OK\n')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(`\\\\.\\pipe\\${pipe}`, resolve))
    process.env.MORROW_LAUNCHER_PIPE = pipe
    await expect(revealInFileManager(path)).resolves.toBeNull()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('系统应用打开文件优先走 ShellExecute，不启动 Explorer 转发', async () => {
    const path = tempFile()
    await expect(openPathFromUserShell(path)).resolves.toBeNull()
    expect(openPathMock).toHaveBeenCalledWith(path)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('目录交给现有 Shell 打开，即使 ShellExecute 失败也不创建 Explorer 进程', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'morrow-reveal-'))
    tempDirs.push(dir)
    spawnMock.mockReturnValue(fakeChild())
    await expect(openPathFromUserShell(dir)).resolves.toBeNull()
    const [command, , options] = spawnMock.mock.calls[0] ?? []
    expect(command).toBe('powershell.exe')
    expect((options as { env: Record<string, string> }).env).toMatchObject({
      MORROW_SHELL_MODE: 'EXPLORE',
      MORROW_SHELL_TARGET: dir
    })
    expect(openPathMock).not.toHaveBeenCalled()
  })
})
})
