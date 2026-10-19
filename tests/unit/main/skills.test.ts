/**
 * R10-H 技能库服务单元测试。
 *
 * 覆盖：发现（工作区 + 用户技能库）、启停状态（含 core 侧过滤）、本地文件夹安装、
 * zip 安装（含单层包装目录）、zip-slip / 绝对路径 / 可执行文件拦截、大小/数量限制、
 * 同名冲突与覆盖安装、删除（工作区技能只读）、详情读取、状态清理、feature:skills:* 处理器。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverSkills, SKILLS_STATE_FILE_ENV, USER_SKILLS_DIR_ENV } from '../../../src/core/tools/skills'
import {
  createSkillsFeatureHandlers,
  createSkillsService,
  installSkillsRuntimeEnv,
  normalizeArchivePath,
  sanitizeSkillDirName,
  SkillsService
} from '../../../src/main/services/skills-service'

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
    await expect(service.install(empty, workspace)).rejects.toThrow(/空的/)

    await expect(service.install('relative/folder', workspace)).rejects.toThrow(/绝对路径/)
    await expect(service.install(join(root, 'nope'), workspace)).rejects.toThrow(/路径不存在/)
  })

  it('文件夹里的可执行/脚本文件与符号链接被拒绝，不落盘', async () => {
    const { root, workspace, service } = makeHarness()
    const withScript = writeSkill(join(root, 'downloads'), 'scripted', '# Scripted\n步骤。')
    writeFileSync(join(withScript, 'run.js'), 'console.log(1)')
    await expect(service.install(withScript, workspace)).rejects.toThrow(/可执行/)
    expect(existsSync(join(service.userDir, 'scripted'))).toBe(false)

    const withExe = writeSkill(join(root, 'downloads'), 'exe', '# Exe\n步骤。')
    writeFileSync(join(withExe, 'tool.exe'), 'MZ')
    await expect(service.install(withExe, workspace)).rejects.toThrow(/可执行/)
    expect(existsSync(join(service.userDir, 'exe'))).toBe(false)
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

  it('zip 内可执行文件、超大文件、文件数超限都拒绝', async () => {
    const { root, workspace, service } = makeHarness()
    const withExe = await makeZip(join(root, 'exe.zip'), {
      'SKILL.md': '# Exe\nx',
      'bin/payload.exe': 'MZ'
    })
    await expect(service.install(withExe, workspace)).rejects.toThrow(/可执行/)

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
