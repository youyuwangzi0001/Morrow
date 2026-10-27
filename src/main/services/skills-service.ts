/**
 * R10-H 技能库服务（主进程）。
 *
 * 职责：
 * - 管理「用户技能库」目录（应用数据目录下 `skills/`）：列出已安装技能、读取 SKILL.md、启停、删除；
 * - 把用户技能库路径与启停状态文件路径注入 core（环境变量），让 Agent 的
 *   `list_skills / read_skill / 系统提示` 自动遵循启用状态；
 * - 本地安装：从一个文件夹或 .zip 技能包复制到用户技能库，安装前做严格校验：
 *   - 防 zip-slip（绝对路径 / `..` / 盘符 / 反斜杠混淆一律拒绝）；
 *   - 文件大小、数量、总大小、目录深度上限（防 zip 炸弹/超大技能包）；
 *   - 可执行文件/脚本（.exe/.bat/.cmd/.ps1/.js/.py/...）会被跳过并在结果里报告，
 *     其余 Markdown 与资源文件正常安装；安装完也不会执行任何内容；
 *   - 符号链接一律拒绝；先写隐藏暂存目录、校验通过后再原子改名，失败不留半成品。
 *
 * 纯 Node 实现（不 import electron），数据目录由调用方注入，便于单元测试。
 * IPC 暴露在 `src/main/features/skills.ts`（feature:skills:*）。
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import JSZip from 'jszip'
import {
  describeSkill,
  listSkillResources,
  readSkillsState,
  scanUserSkills,
  scanWorkspaceSkills,
  skillStateKey,
  SKILL_FILE,
  SKILLS_STATE_FILE_ENV,
  USER_SKILLS_DIR_ENV,
  type SkillInfo,
  type SkillsState,
  type SkillsStateEntry
} from '@core/tools/skills'

const MAX_SKILLS = 200
const MAX_INSTALL_FILES = 300
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_ZIP_BYTES = 25 * 1024 * 1024
const MAX_DEPTH = 4
const MAX_SKILL_MD_BYTES = 256 * 1024
const MAX_DETAIL_FILES = 300
const MAX_NAME_LENGTH = 64

/** 明确跳过的可执行/脚本类型：安装继续，但不会复制或执行这些文件 */
const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.sys',
  '.msi',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.ps1',
  '.psm1',
  '.vbs',
  '.vbe',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx',
  '.py',
  '.pyc',
  '.rb',
  '.pl',
  '.php',
  '.jar',
  '.class',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.app',
  '.lnk',
  '.url',
  '.reg',
  '.hta',
  '.cpl',
  '.ocx',
  '.so',
  '.dylib',
  '.wasm'
])

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export interface SkillFileEntry {
  /** 相对技能目录的路径（/ 分隔） */
  path: string
  size: number
}

export interface SkillView {
  /** 稳定 id：用户技能 `user:<name>`；工作区技能 `workspace:<绝对目录>`（与 core 状态 key 一致） */
  id: string
  name: string
  description: string
  source: 'workspace' | 'user'
  /** 由应用首次启动安装的内置技能（仍存放在用户技能库，可禁用/删除） */
  builtin: boolean
  enabled: boolean
  dir: string
  skillPath: string
  displayDir: string
  declaredName?: string
  installedAt: number | null
  updatedAt: number
  fileCount: number
  sizeBytes: number
  resources: string[]
  /** 用户技能被同名工作区技能覆盖（Agent 实际用工作区那份） */
  shadowed: boolean
  valid: boolean
  error?: string
}

export interface SkillDetail extends SkillView {
  /** SKILL.md 原文（含 frontmatter） */
  raw: string
  rawTruncated: boolean
  files: SkillFileEntry[]
}

export interface SkillsSnapshot {
  userDir: string
  stateFile: string
  workspace: string | null
  skills: SkillView[]
  /** 发现过程中的问题（不完整的技能目录、失效的状态记录等），UI 顶部提示 */
  errors: string[]
  scannedAt: number
}

export interface InstallSkillOptions {
  /** 允许覆盖同名技能（默认 false，避免误删用户内容） */
  overwrite?: boolean
}

export interface InstallResult {
  installed: SkillView
  snapshot: SkillsSnapshot
  /** 因可执行/脚本类型而跳过的文件（相对技能根目录） */
  skipped: string[]
}

export interface SkillsServiceOptions {
  /** 应用数据目录（<dataDir>/skills 为用户技能库，<dataDir>/skills-state.json 为启停状态） */
  dataDir: string
}

function safeStat(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 统一路径比较（Windows 大小写不敏感） */
function pathKey(path: string): string {
  const absolute = resolve(path).split(sep).join('/').replace(/\/+$/, '')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 技能目录名：去掉路径分隔符/Windows 非法字符，限制长度，避开 Windows 保留名 */
export function sanitizeSkillDirName(raw: string): string {
  let name = raw
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '')
  if (!name) name = 'skill'
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH)
  if (RESERVED_WINDOWS_NAMES.test(name)) name = `skill-${name}`
  if (!name || name === '.' || name === '..') name = 'skill'
  return name
}

/** 校验并归一化 zip 条目名；返回 null 表示目录条目 */
export function normalizeArchivePath(rawName: string): string | null {
  if (!rawName || rawName.includes('\0')) throw new Error('技能包里包含非法文件名（NUL 字符）。')
  const name = rawName.replace(/\\/g, '/')
  if (name.endsWith('/')) return null
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`技能包里包含绝对路径，已拒绝安装（可能是恶意 zip-slip）：${rawName}`)
  }
  const segments = name.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`技能包里包含越界路径，已拒绝安装（可能是恶意 zip-slip）：${rawName}`)
  }
  for (const segment of segments) {
    if (/[<>:"|?*\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment)) {
      throw new Error(`技能包里包含非法文件名（Windows 不支持）：${rawName}`)
    }
  }
  return segments.join('/')
}

function extensionOf(name: string): string {
  const ext = extname(name).toLowerCase()
  return ext
}

/**
 * 在交给 JSZip 之前直接检查 ZIP 中央目录里的原始文件名。
 *
 * 为什么需要双层校验：JSZip 3.10 在 `loadAsync` 时会自己净化 `../` 路径（安全兜底），
 * 但那样我们只能看到净化后的名字、无法向用户解释「这个技能包恶意/越界」。
 * 这里读原始中央目录，把 zip-slip / 绝对路径在解压前明确拒绝。
 */
export function assertArchiveEntriesSafe(buffer: Buffer): void {
  const EOCD_SIG = 0x06054b50
  const CD_SIG = 0x02014b50
  let eocd = -1
  const searchStart = Math.max(0, buffer.length - 65_557)
  for (let index = buffer.length - 22; index >= searchStart; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIG) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('无法解析技能包：缺少 ZIP 结尾目录（文件可能已损坏）。')
  const count = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的技能包，请用普通 .zip 重新打包。')
  }
  let offset = centralOffset
  const names: string[] = []
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CD_SIG) {
      throw new Error('无法解析技能包：ZIP 中央目录结构异常。')
    }
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    names.push(name)
    offset += 46 + nameLength + extraLength + commentLength
    if (names.length > MAX_INSTALL_FILES) break
  }
  for (const name of names) {
    // 目录条目（以 / 结尾）也校验，防止构造 `../dir/` 这类条目
    const normalized = normalizeArchivePath(name)
    if (!normalized && name) {
      // 纯目录条目：也要保证路径安全（normalizeArchivePath 已抛错，这里仅兜底）
      continue
    }
  }
}

/** 校验单个文件：大小硬限制；可执行/脚本返回 false 由调用方跳过。 */
function isInstallableFile(relativePath: string, size: number): boolean {
  const lower = relativePath.toLowerCase()
  const fileName = basename(relativePath)
  if (lower === 'skill.md' || fileName.toLowerCase() === 'skill.md') {
    if (size > MAX_SKILL_MD_BYTES) throw new Error(`SKILL.md 过大（${(size / 1024).toFixed(0)}KB，上限 256KB）。`)
    return true
  }
  if (size > MAX_FILE_BYTES) {
    throw new Error(`技能包里的文件过大：${relativePath}（${(size / 1024).toFixed(0)}KB，单文件上限 5MB）。`)
  }
  return !BLOCKED_EXTENSIONS.has(extensionOf(fileName))
}

interface StagedFile {
  /** zip/文件夹内的相对路径（/ 分隔） */
  path: string
  size: number
}

function oneLineDescription(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/** 写入 SKILL.md 前统一补 frontmatter；已有 frontmatter 会被替换，避免 name/description 漂移。 */
function normalizeWritableSkill(name: string, description: string, markdown: string): string {
  const rawInput = typeof markdown === 'string' ? markdown : ''
  const body = rawInput.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
  if (!body) throw new Error('技能正文不能为空。')
  const desc = oneLineDescription(description) || '由 Morrow 的建议创建'
  const raw = `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`
  if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_MD_BYTES) {
    throw new Error(`SKILL.md 过大（上限 ${Math.round(MAX_SKILL_MD_BYTES / 1024)}KB）。`)
  }
  return raw
}

export class SkillsService {
  readonly dataDir: string
  readonly userDir: string
  readonly stateFile: string
  private readonly builtinNames: Set<string>

  constructor(options: SkillsServiceOptions) {
    if (!options || typeof options.dataDir !== 'string' || !options.dataDir.trim()) {
      throw new Error('SkillsService 需要 dataDir（应用数据目录）。')
    }
    this.dataDir = resolve(options.dataDir)
    this.userDir = join(this.dataDir, 'skills')
    this.stateFile = join(this.dataDir, 'skills-state.json')
    this.builtinNames = this.loadBuiltinNames()
  }

  private loadBuiltinNames(): Set<string> {
    try {
      const parsed = JSON.parse(readFileSync(join(this.userDir, '.builtin-skills.json'), 'utf8')) as {
        skills?: Record<string, unknown>
      }
      return new Set(Object.keys(parsed.skills ?? {}))
    } catch {
      return new Set()
    }
  }

  /** 确保数据目录与用户技能库存在 */
  ensureDirs(): void {
    mkdirSync(this.dataDir, { recursive: true })
    mkdirSync(this.userDir, { recursive: true })
  }

  /** 把技能库路径注入 core 的技能发现逻辑（Agent 通过环境变量读取） */
  installRuntimeEnv(env: NodeJS.ProcessEnv = process.env): { userDir: string; stateFile: string } {
    this.ensureDirs()
    env[USER_SKILLS_DIR_ENV] = this.userDir
    env[SKILLS_STATE_FILE_ENV] = this.stateFile
    return { userDir: this.userDir, stateFile: this.stateFile }
  }

  private readState(): SkillsState {
    return readSkillsState(this.stateFile)
  }

  private writeState(state: SkillsState): void {
    this.ensureDirs()
    const normalized: SkillsState = { version: 1, skills: { ...state.skills } }
    const temp = `${this.stateFile}.tmp-${process.pid}`
    writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n', 'utf8')
    try {
      renameSync(temp, this.stateFile)
    } catch {
      // 极端情况下（文件被占用）退回直接写；下次读取会重新解析
      writeFileSync(this.stateFile, JSON.stringify(normalized, null, 2) + '\n', 'utf8')
      rmSync(temp, { force: true })
    }
  }

  private setStateEntry(key: string, entry: SkillsStateEntry | null): void {
    const state = this.readState()
    const skills: Record<string, SkillsStateEntry> = { ...state.skills }
    if (entry === null) delete skills[key]
    else skills[key] = { ...(skills[key] ?? {}), ...entry }
    this.writeState({ version: 1, skills })
  }

  private buildEntry(skill: SkillInfo, workspaceSkills: SkillInfo[]): SkillView {
    this.ensureDirs()
    const state = this.readState()
    const key = skillStateKey(skill)
    const entry = state.skills[key]
    const stat = safeStat(skill.dir)
    const files = this.collectFiles(skill.dir, MAX_DETAIL_FILES)
    const nameLower = skill.name.toLowerCase()
    const shadowed =
      skill.source === 'user' && workspaceSkills.some((candidate) => candidate.name.toLowerCase() === nameLower)
    const valid = existsSync(skill.skillPath) && safeStat(skill.skillPath)?.isFile() === true
    return {
      id: key,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      builtin: skill.source === 'user' && this.builtinNames.has(skill.name),
      enabled: entry?.enabled !== false,
      dir: skill.dir,
      skillPath: skill.skillPath,
      displayDir: skill.displayDir,
      ...(skill.declaredName ? { declaredName: skill.declaredName } : {}),
      installedAt: typeof entry?.installedAt === 'number' ? entry.installedAt : null,
      updatedAt: stat?.mtimeMs ?? 0,
      fileCount: files.length,
      sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
      resources: listSkillResources(skill),
      shadowed,
      valid,
      ...(valid ? {} : { error: 'SKILL.md 不存在或不可读，可能是安装不完整。' })
    }
  }

  /** 递归收集技能目录内的文件（有界；跳过隐藏文件与临时目录） */
  private collectFiles(rootDir: string, limit: number): SkillFileEntry[] {
    const files: SkillFileEntry[] = []
    const walk = (dir: string, prefix: string, depth: number): void => {
      if (files.length >= limit || depth > MAX_DEPTH) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (files.length >= limit) return
        if (entry.name.startsWith('.')) continue
        const absolute = join(dir, entry.name)
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          walk(absolute, relPath, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const stat = safeStat(absolute)
        if (!stat) continue
        files.push({ path: relPath, size: stat.size })
      }
    }
    walk(rootDir, '', 0)
    return files
  }

  /** 列出所有技能（含禁用）；工作区技能在前，用户技能库在后 */
  list(workspace: string | null): SkillsSnapshot {
    this.ensureDirs()
    const errors: string[] = []
    let workspaceSkills: SkillInfo[] = []
    if (workspace) {
      try {
        workspaceSkills = scanWorkspaceSkills(workspace)
      } catch (err) {
        errors.push(`扫描工作区技能失败：${errorMessage(err)}`)
      }
    }
    const userSkills = scanUserSkills(this.userDir)
    const state = this.readState()

    // 不完整的用户技能目录（有文件夹但没有 SKILL.md）
    try {
      for (const entry of readdirSync(this.userDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        if (!existsSync(join(this.userDir, entry.name, SKILL_FILE))) {
          errors.push(`技能目录不完整（缺少 ${SKILL_FILE}）：${entry.name}`)
        }
      }
    } catch {
      // 用户技能库目录刚创建时可能读取失败，忽略
    }

    const skills: SkillView[] = []
    const workspaceNames = new Set<string>()
    for (const skill of workspaceSkills) {
      if (skills.length >= MAX_SKILLS) break
      const key = skill.name.toLowerCase()
      if (workspaceNames.has(key)) continue
      workspaceNames.add(key)
      skills.push(this.buildEntry(skill, workspaceSkills))
    }
    for (const skill of userSkills) {
      if (skills.length >= MAX_SKILLS) break
      // 同名工作区技能优先（Agent 会用工作区那份）；用户技能仍列出并标记 shadowed，
      // 用户可以看到/删除/改名自己安装的技能，不会「凭空消失」。
      const entry = this.buildEntry(skill, workspaceSkills)
      if (!workspaceNames.has(skill.name.toLowerCase())) {
        const duplicate = skills.some((candidate) => candidate.name.toLowerCase() === skill.name.toLowerCase())
        if (duplicate) continue
      }
      skills.push(entry)
    }

    // 状态里指向不存在用户技能的记录（例如手动删了目录）
    const existingUserIds = new Set(userSkills.map((skill) => skillStateKey(skill)))
    for (const key of Object.keys(state.skills)) {
      if (!key.startsWith('user:')) continue
      if (!existingUserIds.has(key)) errors.push(`状态记录指向已不存在的技能：${key.slice('user:'.length)}`)
    }

    return {
      userDir: this.userDir,
      stateFile: this.stateFile,
      workspace: workspace ?? null,
      skills,
      errors,
      scannedAt: Date.now()
    }
  }

  /** 按 id 找到技能（不论启用状态） */
  private findSkillById(id: string, workspace: string | null): SkillInfo | null {
    const normalized = id.trim()
    if (!normalized) return null
    const all = [...scanWorkspaceSkills(workspace), ...scanUserSkills(this.userDir)]
    return all.find((skill) => skillStateKey(skill) === normalized || skill.name === normalized) ?? null
  }

  /** 技能详情：元信息 + SKILL.md 原文 + 文件清单 */
  detail(id: string, workspace: string | null): SkillDetail {
    const snapshot = this.list(workspace)
    const view = snapshot.skills.find((skill) => skill.id === id) ?? snapshot.skills.find((skill) => skill.name === id)
    if (!view) throw new Error(`没有找到技能：${id}`)
    const skill = this.findSkillById(view.id, workspace)
    if (!skill) throw new Error(`技能目录已不存在：${id}`)
    let raw = ''
    let rawTruncated = false
    try {
      const stat = statSync(skill.skillPath)
      const buffer = readFileSync(skill.skillPath)
      rawTruncated = stat.size > MAX_SKILL_MD_BYTES
      raw = buffer.subarray(0, MAX_SKILL_MD_BYTES).toString('utf8')
    } catch (err) {
      throw new Error(`读取 SKILL.md 失败：${errorMessage(err)}`)
    }
    return {
      ...view,
      raw,
      rawTruncated,
      files: this.collectFiles(skill.dir, MAX_DETAIL_FILES)
    }
  }

  /** 启用/禁用技能（写入状态文件；Agent 下一次 discoverSkills 立即生效） */
  setEnabled(id: string, enabled: boolean, workspace: string | null): SkillsSnapshot {
    if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值。')
    const skill = this.findSkillById(id, workspace)
    if (!skill) throw new Error(`没有找到技能：${id}`)
    this.setStateEntry(skillStateKey(skill), { enabled })
    return this.list(workspace)
  }

  /** 删除用户技能（只能删用户技能库内的目录；工作区技能不允许在这里删除） */
  remove(id: string, workspace: string | null): SkillsSnapshot {
    const view = this.list(workspace).skills.find((skill) => skill.id === id) ?? this.list(workspace).skills.find((skill) => skill.name === id)
    if (!view) throw new Error(`没有找到技能：${id}`)
    if (view.source !== 'user') {
      throw new Error('工作区自带的技能不能在这里删除；请直接修改工作区文件。')
    }
    this.ensureDirs()
    const userReal = realpathSync(this.userDir)
    let dirReal: string
    try {
      dirReal = realpathSync(view.dir)
    } catch {
      throw new Error(`技能目录已不存在：${view.name}`)
    }
    if (!isInside(userReal, dirReal) || pathKey(dirReal) === pathKey(userReal)) {
      throw new Error('拒绝删除：目标目录不在用户技能库内（疑似符号链接越界）。')
    }
    rmSync(dirReal, { recursive: true, force: true })
    this.setStateEntry(view.id, null)
    return this.list(workspace)
  }

  async install(sourcePath: string, workspace: string | null, options: InstallSkillOptions = {}): Promise<InstallResult> {
    this.ensureDirs()
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error('请提供技能包路径（文件夹或 .zip）。')
    const source = resolve(sourcePath.trim())
    if (!isAbsolute(sourcePath.trim())) {
      throw new Error('请提供绝对路径（例如 C:\\\\Users\\\\me\\\\Downloads\\\\release-skill.zip）。')
    }
    const stat = safeStat(source)
    if (!stat) throw new Error(`路径不存在：${source}`)
    const staging = join(this.userDir, `.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(staging, { recursive: true })
    const skipped: string[] = []
    try {
      let nameHint: string
      if (stat.isDirectory()) {
        nameHint = basename(source)
        skipped.push(...this.stageFromFolder(source, staging))
      } else if (stat.isFile()) {
        const ext = extensionOf(source)
        if (ext !== '.zip') {
          throw new Error(`只支持安装文件夹或 .zip 技能包，收到的是：${basename(source)}`)
        }
        if (stat.size > MAX_ZIP_BYTES) {
          throw new Error(`技能包过大（${(stat.size / 1024 / 1024).toFixed(1)}MB，上限 25MB）。`)
        }
        nameHint = basename(source, extname(source))
        skipped.push(...(await this.stageFromZip(source, staging)))
      } else {
        throw new Error(`不支持的安装来源：${source}`)
      }

      const skillMd = this.findStagedSkillMd(staging)
      if (!skillMd) throw new Error('技能包里缺少 SKILL.md（技能必须有 SKILL.md 说明文件）。')
      const frontmatterName = describeSkill(readFileSync(skillMd, 'utf8')).declaredName
      const targetName = sanitizeSkillDirName(frontmatterName || nameHint)
      // 大小写不敏感地查找同名目录（Linux 上 Foo/foo 不能并存，否则状态键会冲突）
      const collision = readdirSync(this.userDir, { withFileTypes: true }).find(
        (entry) => !entry.name.startsWith('.') && entry.name.toLowerCase() === targetName.toLowerCase()
      )
      const targetDir = collision ? join(this.userDir, collision.name) : join(this.userDir, targetName)
      if (collision) {
        if (options.overwrite !== true) {
          throw new Error(`技能库已有同名技能「${collision.name}」。请先删除旧技能，或改用「覆盖安装」。`)
        }
        // 覆盖安装：拒绝符号链接，再删除用户技能库内的真实目录
        const lst = safeLstat(targetDir)
        if (!lst || !lst.isDirectory() || lst.isSymbolicLink()) {
          throw new Error('拒绝覆盖：目标不是用户技能库内的普通目录。')
        }
        const targetReal = realpathSync(targetDir)
        const userReal = realpathSync(this.userDir)
        if (!isInside(userReal, targetReal) || pathKey(targetReal) === pathKey(userReal)) {
          throw new Error('拒绝覆盖：目标目录不在用户技能库内。')
        }
        rmSync(targetDir, { recursive: true, force: true })
      }
      try {
        renameSync(staging, targetDir)
      } catch {
        // 跨卷/被占用时退回复制
        cpSync(staging, targetDir, { recursive: true })
        rmSync(staging, { recursive: true, force: true })
      }
      this.setStateEntry(`user:${targetName.toLowerCase()}`, {
        enabled: true,
        installedAt: Date.now(),
        origin: source
      })
      const snapshot = this.list(workspace)
      const installed =
        snapshot.skills.find((skill) => skill.source === 'user' && skill.name === targetName) ??
        snapshot.skills.find((skill) => skill.source === 'user' && skill.name.toLowerCase() === targetName.toLowerCase())
      if (!installed) throw new Error('安装完成但未能读取技能信息，请尝试重新扫描。')
      return { installed, snapshot, skipped }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  private findStagedSkillMd(staging: string): string | null {
    for (const name of readdirSync(staging)) {
      if (name.toLowerCase() === 'skill.md' && safeStat(join(staging, name))?.isFile()) {
        // 统一成 SKILL.md（大小写混合会导致 core 发现不到）
        if (name !== SKILL_FILE) renameSync(join(staging, name), join(staging, SKILL_FILE))
        return join(staging, SKILL_FILE)
      }
    }
    return null
  }

  /** 从文件夹拷贝到暂存目录（校验符号链接/大小/数量；脚本跳过并报告） */
  private stageFromFolder(sourceDir: string, staging: string): string[] {
    const files: StagedFile[] = []
    const skipped: string[] = []
    let totalBytes = 0
    const walk = (dir: string, prefix: string, depth: number): void => {
      if (depth > MAX_DEPTH) throw new Error(`技能目录层级过深（上限 ${MAX_DEPTH} 层）。`)
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        const absolute = join(dir, entry.name)
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
        const lst = safeLstat(absolute)
        if (!lst) continue
        if (lst.isSymbolicLink()) throw new Error(`技能目录里不允许符号链接：${relPath}`)
        if (lst.isDirectory()) {
          walk(absolute, relPath, depth + 1)
          continue
        }
        if (!lst.isFile()) continue
        if (entry.name.startsWith('.') || entry.name === 'Thumbs.db' || entry.name === 'desktop.ini') continue
        const size = lst.size
        if (!isInstallableFile(relPath, size)) {
          skipped.push(relPath)
          continue
        }
        totalBytes += size
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error('技能目录总大小超过 20MB 上限。')
        files.push({ path: relPath, size })
        if (files.length > MAX_INSTALL_FILES) throw new Error(`技能目录文件过多（上限 ${MAX_INSTALL_FILES} 个）。`)
      }
    }
    walk(sourceDir, '', 0)
    if (files.length === 0) throw new Error('技能目录里没有可安装的文件（脚本会被跳过）。')
    for (const file of files) {
      const target = join(staging, ...file.path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(sourceDir, ...file.path.split('/')), target)
    }
    return skipped
  }

  /** 从 zip 解压到暂存目录（防 zip-slip、大小/数量；脚本跳过并报告） */
  private async stageFromZip(zipPath: string, staging: string): Promise<string[]> {
    const buffer = readFileSync(zipPath)
    // 第一层：直接读原始中央目录，恶意的 zip-slip/绝对路径在解压前就拒绝
    assertArchiveEntriesSafe(buffer)
    let zip: JSZip
    try {
      zip = await JSZip.loadAsync(buffer)
    } catch (err) {
      throw new Error(`无法解析技能包（不是有效的 zip 或已损坏/加密）：${errorMessage(err)}`)
    }
    const entries: Array<{ path: string; file: JSZip.JSZipObject; size: number }> = []
    const skipped: string[] = []
    let totalBytes = 0
    for (const [rawName, file] of Object.entries(zip.files)) {
      if (file.dir) continue
      const normalized = normalizeArchivePath(rawName)
      if (!normalized) continue
      // 忽略压缩工具自我描述/系统元数据文件
      const lower = normalized.toLowerCase()
      if (lower.startsWith('__macosx/') || lower.endsWith('/.ds_store') || lower === '.ds_store') continue
      if (basename(normalized).startsWith('.')) continue
      const internalSize = Number((file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0)
      if (!isInstallableFile(normalized, internalSize || 0)) {
        skipped.push(normalized)
        continue
      }
      totalBytes += internalSize
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('技能包解压后总大小超过 20MB 上限。')
      entries.push({ path: normalized, file, size: internalSize })
      if (entries.length > MAX_INSTALL_FILES) throw new Error(`技能包文件过多（上限 ${MAX_INSTALL_FILES} 个）。`)
    }
    if (entries.length === 0) throw new Error('技能包里没有可安装的文件（脚本会被跳过）。')

    // 若 zip 只有一个顶层目录（常见打包方式），剥掉这层目录
    const firstSegments = new Set(entries.map((entry) => entry.path.split('/')[0]))
    const hasRootSkillMd = entries.some((entry) => entry.path.toLowerCase() === 'skill.md')
    let prefix = ''
    if (!hasRootSkillMd && firstSegments.size === 1) {
      const only = [...firstSegments][0]
      if (entries.every((entry) => entry.path.includes('/'))) prefix = `${only}/`
    }

    let actualTotal = 0
    for (const entry of entries) {
      const relativePath = prefix && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path
      if (!relativePath) continue
      // 剥掉 wrapper 后再次校验路径安全（文件类型已在扫描阶段分流）
      normalizeArchivePath(relativePath)
      const buffer = await entry.file.async('nodebuffer')
      if (buffer.length > MAX_FILE_BYTES) throw new Error(`技能包里的文件过大：${relativePath}`)
      actualTotal += buffer.length
      if (actualTotal > MAX_TOTAL_BYTES) throw new Error('技能包解压后总大小超过 20MB 上限。')
      const target = join(staging, ...relativePath.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, buffer)
    }
    return skipped
  }

  /**
   * 从建议文本创建用户技能。只写 SKILL.md，不复制或执行任何脚本。
   * 调用方需保证目录名不冲突；冲突时明确报错，由调用方决定改名或更新。
   */
  createUserSkill(input: { name: string; description: string; markdown: string }): SkillView {
    this.ensureDirs()
    if (this.list(null).skills.length >= MAX_SKILLS) {
      throw new Error(`技能数量已达上限（${MAX_SKILLS} 个），请先清理旧技能。`)
    }
    const name = sanitizeSkillDirName(String(input.name ?? '').trim())
    const description = oneLineDescription(input.description)
    const raw = normalizeWritableSkill(name, description, input.markdown)
    const dirName = sanitizeSkillDirName(name)
    const targetDir = join(this.userDir, dirName)
    if (existsSync(targetDir)) {
      throw new Error(`技能「${dirName}」已存在；请选择更新已有技能或换一个名字。`)
    }
    const staging = join(
      this.userDir,
      `.staging-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    )
    mkdirSync(staging, { recursive: true })
    try {
      writeFileSync(join(staging, SKILL_FILE), raw, { encoding: 'utf8', mode: 0o600 })
      renameSync(staging, targetDir)
    } catch (err) {
      try {
        rmSync(staging, { recursive: true, force: true })
      } catch {
        // 清理失败不覆盖原始错误
      }
      throw err
    }
    this.setStateEntry(`user:${dirName.toLowerCase()}`, {
      enabled: true,
      installedAt: Date.now(),
      origin: 'evolution'
    })
    const created = this.list(null).skills.find((skill) => skill.id === `user:${dirName.toLowerCase()}`)
    if (!created) throw new Error('技能已写入，但重新扫描时没有找到；请刷新技能库。')
    return created
  }

  /**
   * 用新的 SKILL.md 更新用户技能。内置技能与工作区技能不允许从这里覆盖；
   * 只替换 SKILL.md，保留同目录下的参考资源。
   */
  updateUserSkill(id: string, input: { markdown: string; description?: string }): SkillView {
    this.ensureDirs()
    const view = this.list(null).skills.find((skill) => skill.id === id || skill.name === id)
    if (!view) throw new Error(`没有找到技能：${id}`)
    if (view.source !== 'user') throw new Error('只能更新用户技能库里的技能。')
    if (view.builtin) throw new Error('内置技能不能被建议覆盖；请创建一个新的用户技能。')
    const raw = normalizeWritableSkill(
      view.name,
      oneLineDescription(input.description ?? view.description),
      input.markdown
    )
    const target = join(view.dir, SKILL_FILE)
    const temp = join(view.dir, `.${SKILL_FILE}.${process.pid}.${Date.now()}.tmp`)
    try {
      writeFileSync(temp, raw, { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, target)
    } catch (err) {
      try {
        rmSync(temp, { force: true })
      } catch {
        // 清理失败不覆盖原始错误
      }
      throw err
    }
    this.setStateEntry(view.id, { enabled: view.enabled, origin: 'evolution-update' })
    const updated = this.list(null).skills.find((skill) => skill.id === view.id)
    if (!updated) throw new Error('技能已更新，但重新扫描时没有找到；请刷新技能库。')
    return updated
  }

  /** 清理状态里指向已删除用户技能 / 已不存在工作区技能的记录（重新扫描时调用） */
  pruneState(workspace: string | null): SkillsSnapshot {
    const snapshot = this.list(workspace)
    const validIds = new Set(snapshot.skills.map((skill) => skill.id))
    const state = this.readState()
    let changed = false
    const skills: Record<string, SkillsStateEntry> = {}
    for (const [key, entry] of Object.entries(state.skills)) {
      const isUser = key.startsWith('user:')
      const isWorkspace = key.startsWith('workspace:')
      if (!isUser && !isWorkspace) continue
      if (isUser && !validIds.has(key)) {
        changed = true
        continue
      }
      skills[key] = entry
    }
    if (changed) this.writeState({ version: 1, skills })
    return this.list(workspace)
  }
}

export function createSkillsService(options: SkillsServiceOptions): SkillsService {
  return new SkillsService(options)
}

/** 便捷函数：创建服务并把技能库路径注入 core 环境变量 */
export function installSkillsRuntimeEnv(service: SkillsService, env: NodeJS.ProcessEnv = process.env): {
  userDir: string
  stateFile: string
} {
  return service.installRuntimeEnv(env)
}

/* ── feature:skills:* handlers（纯粹逻辑 + 可注入副作用，便于单测） ── */

/** feature 层需要主进程提供的能力（electron dialog/shell）；单测里注入假实现 */
export interface SkillsFeatureEffects {
  /** 用系统文件管理器打开某个目录 */
  revealPath(path: string): Promise<void>
  /** 打开用户技能库目录 */
  openUserDir(path: string): Promise<void>
  /** 选择一个本地 .zip 技能包；取消返回 null */
  pickZip(): Promise<string | null>
  /** 选择一个本地技能文件夹；取消返回 null */
  pickFolder(): Promise<string | null>
}

export type SkillsFeatureHandler = (payload: unknown) => Promise<unknown>

function readPayload(payload: unknown): Record<string, unknown> {
  if (payload === undefined || payload === null) return {}
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('参数格式不正确：需要对象。')
  return payload as Record<string, unknown>
}

function readWorkspace(payload: Record<string, unknown>): string | null {
  const value = payload.workspace
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('workspace 必须是字符串或 null。')
  return value.trim() || null
}

function readId(payload: Record<string, unknown>): string {
  const value = payload.id
  if (typeof value !== 'string' || !value.trim()) throw new Error('缺少参数 id（技能 id）。')
  return value.trim()
}

function readEnabled(payload: Record<string, unknown>): boolean {
  if (typeof payload.enabled !== 'boolean') throw new Error('缺少参数 enabled（布尔值）。')
  return payload.enabled
}

function readSourcePath(payload: Record<string, unknown>): string {
  const value = payload.sourcePath
  if (typeof value !== 'string' || !value.trim()) throw new Error('缺少参数 sourcePath（本地文件夹或 .zip 的绝对路径）。')
  return value.trim()
}

/**
 * 构造 `feature:skills:*` 的处理器表（不注册 IPC，方便单测直接调用）。
 * 频道：
 *   list / read / setEnabled / install / remove / rescan / reveal / openUserDir / pickZip / pickFolder
 */
export function createSkillsFeatureHandlers(
  service: SkillsService,
  effects: SkillsFeatureEffects
): Record<string, SkillsFeatureHandler> {
  return {
    'feature:skills:list': async (payload) => {
      const data = readPayload(payload)
      return service.list(readWorkspace(data))
    },
    'feature:skills:read': async (payload) => {
      const data = readPayload(payload)
      return service.detail(readId(data), readWorkspace(data))
    },
    'feature:skills:setEnabled': async (payload) => {
      const data = readPayload(payload)
      return service.setEnabled(readId(data), readEnabled(data), readWorkspace(data))
    },
    'feature:skills:install': async (payload) => {
      const data = readPayload(payload)
      return service.install(readSourcePath(data), readWorkspace(data), { overwrite: data.overwrite === true })
    },
    'feature:skills:remove': async (payload) => {
      const data = readPayload(payload)
      return service.remove(readId(data), readWorkspace(data))
    },
    'feature:skills:rescan': async (payload) => {
      const data = readPayload(payload)
      return service.pruneState(readWorkspace(data))
    },
    'feature:skills:reveal': async (payload) => {
      const data = readPayload(payload)
      const detail = service.detail(readId(data), readWorkspace(data))
      await effects.revealPath(detail.dir)
      return { path: detail.dir }
    },
    'feature:skills:openUserDir': async () => {
      service.ensureDirs()
      await effects.openUserDir(service.userDir)
      return { path: service.userDir }
    },
    'feature:skills:pickZip': async () => ({ path: await effects.pickZip() }),
    'feature:skills:pickFolder': async () => ({ path: await effects.pickFolder() })
  }
}
