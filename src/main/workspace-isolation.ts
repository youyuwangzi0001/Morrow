import { constants as fsConstants, promises as fsp, type Dirent } from 'node:fs'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  realpathSync
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import type {
  WorkspaceCopy,
  WorkspaceIsolationPort,
  WorkspaceMergeApplied,
  WorkspaceMergeConflict,
  WorkspaceMergeResult
} from '../core/types'
import type { CollaborationConflict } from '../shared/types'
import { resolveDataDir } from './workspace'
import { log } from './logger'

const SAFE_ID = /^[A-Za-z0-9_-]{3,100}$/
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.morrow',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'coverage',
  'deliver',
  'release',
  'tmp',
  'logs',
  'test-results',
  'win-unpacked',
  'Morrow Data',
  '.qoder',
  // 各平台工具链与构建缓存：体积通常是源码的几十倍，复制进副本既慢又会被上限拒绝。
  // 它们只建链接、不复制文件，成员在副本里照样能跑构建。
  '.build',
  '.sdk',
  '.toolchain',
  '.electron-dist',
  '.gradle',
  '.android',
  '.dart_tool',
  '.pub-cache',
  '.turbo',
  '.parcel-cache',
  '.angular',
  '.expo',
  '.yarn',
  '.pnpm-store',
  '.sass-cache',
  '.swiftpm',
  'bower_components',
  'DerivedData',
  'Pods',
  '.terraform'
])
const NON_LINKED_DIRS = new Set(['Morrow Data', '.qoder'])
const MAX_FILES = 30_000
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const MAX_HASH_BYTES = 8 * 1024 * 1024
const MAX_TEXT_MERGE_BYTES = 2 * 1024 * 1024
const PREVIEW_CHARS = 2_000
/** 已结束任务留下的副本记录保留天数：冲突需要它来定位成员版本。 */
const RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** 正在复制中的基线目录（.tmp-*）被判定为残留的最小年龄。 */
const STAGING_TTL_MS = 60 * 60 * 1000

function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name) || name.startsWith('.morrow-runtime-')
}

/** 目录树体积统计：只 stat 不读内容，用来决定哪些大目录改用共享链接。 */
interface DirNode {
  path: string
  bytes: number
  files: number
  dirs: DirNode[]
}

/** 成为「可共享大目录」的默认门槛；上限更小时按比例缩小，保证小上限也能降级。 */
const SHARE_MIN_BYTES = 64 * 1024 * 1024
const SHARE_MIN_FILES = 5_000
/** 降级后仍要留出余量：按上限的 85% 收敛，避免边缘抖动。 */
const SHARE_HEADROOM = 0.85
/** 源码/配置目录绝不做共享链接：成员必须能在真实副本里改它们，合并才有意义。 */
const PROTECTED_DIRS = new Set([
  'src',
  'app',
  'apps',
  'lib',
  'libs',
  'packages',
  'source',
  'sources',
  'scripts',
  'config',
  'configs',
  'docs',
  'test',
  'tests',
  'e2e',
  'spec',
  'specs',
  'features',
  'routes',
  'pages',
  'components',
  'public',
  'assets',
  'styles',
  'css',
  'js',
  'ts',
  'api',
  'server',
  'client',
  'shared',
  'core',
  'utils'
])

function isProtectedPath(rel: string): boolean {
  const parts = rel.split('/')
  // 任何一层是受保护目录名，都不共享（源码可能在任意层级）
  return parts.some((part) => PROTECTED_DIRS.has(part))
}

/**
 * 挑出「最小的大目录」：优先共享 node_modules、SDK、编译缓存这类纯大块。
 * 源码/配置目录永不共享——成员必须在真实副本里改它们，合并才有意义。
 */
export function pickSharedDirs(root: DirNode, limits: WorkspaceIsolationLimits): string[] {
  const byteBudget = limits.maxBytes * SHARE_HEADROOM
  const fileBudget = limits.maxFiles * SHARE_HEADROOM
  const fits = (bytes: number, files: number): boolean => bytes <= byteBudget && files <= fileBudget
  // 已经在上限内就不降级：完整副本的隔离性最强
  if (fits(root.bytes, root.files)) return []
  // 门槛跟着上限走，避免上限被调小时永远挑不出候选
  const minBytes = Math.min(SHARE_MIN_BYTES, limits.maxBytes / 4)
  const minFiles = Math.min(SHARE_MIN_FILES, Math.max(1, Math.floor(limits.maxFiles / 4)))
  const isBig = (node: DirNode): boolean => node.bytes >= minBytes || node.files >= minFiles

  const chosen: string[] = []
  let bytes = root.bytes
  let files = root.files
  const share = (node: DirNode): void => {
    chosen.push(node.path)
    bytes -= node.bytes
    files -= node.files
  }
  /**
   * 自顶向下找可共享的最小单元：
   * - 受保护的源码目录整棵跳过（继续下钻也只会在源码里挑，没有意义）；
   * - 自身够大而子目录都不够大时，共享这一块；
   * - 子目录里还有大块就继续下钻，避免把含源码的父目录整体共享掉。
   */
  const collect = (node: DirNode): void => {
    if (fits(bytes, files)) return
    if (node.path && isProtectedPath(node.path)) return
    const bigChildren = node.dirs.filter(isBig).filter((child) => !isProtectedPath(child.path))
    if (bigChildren.length === 0) {
      if (node.path) share(node)
      return
    }
    for (const child of bigChildren.sort((a, b) => b.bytes - a.bytes)) {
      if (fits(bytes, files)) return
      collect(child)
    }
  }
  collect(root)
  return chosen.sort()
}

function limitLabel(limits: WorkspaceIsolationLimits): { files: number; bytes: string } {
  return {
    files: limits.maxFiles,
    bytes: `${Math.round(limits.maxBytes / (1024 * 1024))}MB`
  }
}

export interface WorkspaceIsolationLimits {
  maxFiles: number
  maxBytes: number
}

const DEFAULT_LIMITS: WorkspaceIsolationLimits = { maxFiles: MAX_FILES, maxBytes: MAX_TOTAL_BYTES }

interface Entry {
  path: string
  kind: 'file' | 'symlink'
  size: number
  hash: string
  target?: string
}

interface Manifest {
  entries: Map<string, Entry>
  hash: string
  fileCount: number
  totalBytes: number
}

/** 一次源清单计算的结果：清单 + 需要改为共享链接的目录 + 生效的忽略规则。 */
interface PreparedSource {
  manifest: Manifest
  shared: ReadonlySet<string>
}

interface CopyRecord extends WorkspaceCopy {
  baselineManifest: string
  createdAt: number
  /** 已自动释放：副本目录已删除，记录只留作追溯。 */
  releasedAt?: number
}

/** 基线目录的内容指纹标记：同名目录被复用时靠它确认内容一致。 */
interface BaseMarker {
  hash: string
  fileCount: number
  totalBytes: number
  createdAt: number
}

export class WorkspaceIsolationError extends Error {
  readonly hint: string

  constructor(message: string, hint: string) {
    super(message)
    this.name = 'WorkspaceIsolationError'
    this.hint = hint
  }
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function insideRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function fileHash(file: string, stat = statSync(file)): string {
  if (stat.size > MAX_HASH_BYTES) return `meta:${stat.size}:${Math.round(stat.mtimeMs)}`
  return sha256(readFileSync(file))
}

async function fileHashAsync(file: string, stat: { size: number; mtimeMs: number }): Promise<string> {
  if (stat.size > MAX_HASH_BYTES) return `meta:${stat.size}:${Math.round(stat.mtimeMs)}`
  return sha256(await fsp.readFile(file))
}

function isTextFile(file: string): boolean {
  try {
    const stat = statSync(file)
    if (stat.size > MAX_TEXT_MERGE_BYTES) return false
    const content = readFileSync(file)
    return !content.includes(0)
  } catch {
    return false
  }
}

function readText(file: string | undefined): string {
  if (!file) return ''
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function preview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n…` : text
}

function lineStats(before: string, after: string): { diffAdded: number; diffRemoved: number } {
  const a = before ? before.split(/\r?\n/).length : 0
  const b = after ? after.split(/\r?\n/).length : 0
  return { diffAdded: Math.max(0, b - a), diffRemoved: Math.max(0, a - b) }
}

export function canonicalWorkspacePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.?\//, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function canonicalKey(path: string): string {
  return canonicalWorkspacePath(path)
}

/** 目录真实占用：只累加文件本身，不跟随 junction（否则会重复计算被链接的依赖目录）。 */
function dirSize(root: string): number {
  let total = 0
  const visit = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        total += statSync(full).size
      } catch {
        // 文件在统计过程中被删除，忽略
      }
    }
  }
  visit(root)
  return total
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function osRelative(path: string): string {
  return path.split('/').join(sep)
}

function runGit(cwd: string, args: string[], timeoutMs = 60_000): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status
    }
  } catch (err) {
    return { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err), status: null }
  }
}

function samePath(a: string, b: string): boolean {
  // Git 返回长路径，Windows 临时目录可能是 8.3 短名；两边都展开后再比较
  const canonical = (value: string): string => {
    try {
      return realpathSync.native(value)
    } catch {
      return resolve(value)
    }
  }
  const x = canonical(a).replace(/[\\/]+$/, '')
  const y = canonical(b).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * 给每个写文件的协作成员一份独立工作副本：
 * - Git 仓库根目录优先使用 detached worktree（保留 Git 元数据），否则普通复制；
 * - 基线包含用户当前未提交的修改；
 * - 合并时逐份比对，整文件冲突保留主版本与成员版本，不静默覆盖。
 */
export class WorkspaceIsolationService implements WorkspaceIsolationPort {
  constructor(
    private readonly dataDir?: string,
    private readonly limits: WorkspaceIsolationLimits = DEFAULT_LIMITS
  ) {}

  private root(projectId: string): string {
    if (!SAFE_ID.test(projectId)) throw new WorkspaceIsolationError('项目编号不合法，已拒绝创建工作副本。', '请重新打开这个对话。')
    return join(this.dataDir ?? resolveDataDir(), 'collaboration', 'workspaces', projectId)
  }

  private recordPath(projectId: string, copyId: string): string {
    return join(this.root(projectId), 'records', `${copyId}.json`)
  }

  private basePath(projectId: string, baseKey: string): string {
    return join(this.root(projectId), 'bases', baseKey)
  }

  private markerPath(projectId: string, baseKey: string): string {
    return join(this.root(projectId), 'bases', '.markers', `${baseKey}.json`)
  }

  private readMarker(projectId: string, baseKey: string): BaseMarker | null {
    try {
      const raw = JSON.parse(readFileSync(this.markerPath(projectId, baseKey), 'utf8')) as BaseMarker
      return typeof raw?.hash === 'string' ? raw : null
    } catch {
      return null
    }
  }

  private writeMarker(projectId: string, baseKey: string, marker: BaseMarker): void {
    const file = this.markerPath(projectId, baseKey)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(marker, null, 2), 'utf8')
  }

  /** 读出项目内所有副本记录（含已释放的）。记录损坏时跳过，不影响其他副本。 */
  private allRecords(projectId: string): CopyRecord[] {
    const dir = join(this.root(projectId), 'records')
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const records: CopyRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.merge.json')) continue
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as CopyRecord
        if (raw && typeof raw.copyId === 'string') records.push(raw)
      } catch {
        // 半写入的记录：按孤儿处理，交给 prune 清理
      }
    }
    return records
  }

  /** 复用同一基线时可能有多份副本共用 basePath，只有最后一个释放才能删目录。 */
  private baseStillReferenced(projectId: string, basePath: string, exceptCopyId: string): boolean {
    const target = canonicalWorkspacePath(basePath)
    if ((this.preparingBases.get(`${projectId}|${target}`) ?? 0) > 0) return true
    return this.allRecords(projectId).some(
      (record) =>
        record.copyId !== exceptCopyId &&
        !record.releasedAt &&
        canonicalWorkspacePath(record.basePath ?? '') === target
    )
  }

  private saveRecord(record: CopyRecord): void {
    const file = this.recordPath(record.projectId, record.copyId)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(record, null, 2), 'utf8')
  }

  private loadRecord(projectId: string, copyId: string): CopyRecord | null {
    try {
      const raw = JSON.parse(readFileSync(this.recordPath(projectId, copyId), 'utf8')) as CopyRecord
      return raw && raw.copyId === copyId ? raw : null
    } catch {
      return null
    }
  }

  private async measureDirs(root: string): Promise<DirNode> {
    const node = (path: string): DirNode => ({ path, bytes: 0, files: 0, dirs: [] })
    const tree = node('')
    const visit = async (dir: string, prefix: string, current: DirNode): Promise<void> => {
      let dirents: Dirent[]
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const dirent of dirents) {
        if (dirent.name === '.git' || isIgnoredDir(dirent.name)) continue
        const absolute = join(dir, dirent.name)
        const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name
        if (dirent.isDirectory()) {
          const child = node(rel)
          current.dirs.push(child)
          await visit(absolute, rel, child)
          current.bytes += child.bytes
          current.files += child.files
          continue
        }
        if (dirent.isSymbolicLink()) continue
        if (!dirent.isFile()) continue
        try {
          const stat = await fsp.stat(absolute)
          current.bytes += stat.size
          current.files += 1
        } catch {
          // 统计期间被删除：忽略
        }
      }
    }
    await visit(root, '', tree)
    return tree
  }

  private async walkAsync(
    root: string,
    shared: ReadonlySet<string> = new Set(),
    options: { unlimited?: boolean } = {}
  ): Promise<Entry[]> {
    const entries: Entry[] = []
    const limits = limitLabel(this.limits)
    const sizes = new Map<string, { bytes: number; files: number; dir: boolean }>()
    let totalBytes = 0
    let totalFiles = 0
    const note = (rel: string, size: number, isDir: boolean): void => {
      const key = rel.split('/')[0]!
      const cell = sizes.get(key) ?? { bytes: 0, files: 0, dir: isDir }
      cell.bytes += size
      cell.files += 1
      cell.dir = cell.dir || isDir
      sizes.set(key, cell)
    }
    const tooBig = (kind: 'files' | 'bytes'): WorkspaceIsolationError => {
      const ranked = [...sizes.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 3)
      const top = ranked.map(
        ([path, cell]) => `${path}${cell.dir ? '/' : ''}（${Math.round(cell.bytes / (1024 * 1024))}MB，${cell.files} 个文件）`
      )
      const detail = top.length > 0 ? `占用最大的是 ${top.join('、')}。` : ''
      const message =
        kind === 'files'
          ? `必需的源码副本仍超过 ${limits.files} 个文件（当前 ${totalFiles} 个）。`
          : `必需的源码副本仍有 ${Math.round(totalBytes / (1024 * 1024))}MB，超过上限 ${limits.bytes}。`
      return new WorkspaceIsolationError(
        `${message}大目录已自动改为共享链接，仍放不下说明待改动的代码本身就超限。`,
        `${detail}可以把项目拆到更小的工作区再执行。`
      )
    }
    const visit = async (dir: string, prefix: string): Promise<void> => {
      const dirents = await fsp.readdir(dir, { withFileTypes: true })
      for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
        if (dirent.name === '.git' || isIgnoredDir(dirent.name)) continue
        const absolute = join(dir, dirent.name)
        const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name
        if (dirent.isDirectory()) {
          // 共享目录不进清单：成员能读能跑，但合并时不会碰它，避免覆盖真实文件
          if (shared.has(rel)) continue
          note(rel, 0, true)
          await visit(absolute, rel)
          continue
        }
        if (dirent.isSymbolicLink()) {
          const target = await fsp.readlink(absolute)
          entries.push({ path: rel, kind: 'symlink', size: 0, hash: sha256(`link:${target}`), target })
          continue
        }
        if (!dirent.isFile()) continue
        const stat = await fsp.stat(absolute)
        totalBytes += stat.size
        totalFiles += 1
        note(rel, stat.size, false)
        entries.push({ path: rel, kind: 'file', size: stat.size, hash: await fileHashAsync(absolute, stat) })
        if (!options.unlimited && entries.length > this.limits.maxFiles) throw tooBig('files')
        if (!options.unlimited && totalBytes > this.limits.maxBytes) throw tooBig('bytes')
      }
    }
    await visit(root, '')
    return entries
  }

  private async manifestAsync(
    root: string,
    shared: ReadonlySet<string> = new Set(),
    options: { unlimited?: boolean } = {}
  ): Promise<Manifest> {
    const entries = await this.walkAsync(root, shared, options)
    const hash = sha256(
      entries
        .map((entry) => `${entry.path}\0${entry.hash}\0${entry.kind}`)
        .sort()
        .join('\n')
    )
    return {
      entries: new Map(entries.map((entry) => [entry.path, entry])),
      hash,
      fileCount: entries.length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0)
    }
  }

  private async copyTreeAsync(
    source: string,
    destination: string,
    budget: { files: number; bytes: number },
    prefix = '',
    shared: ReadonlySet<string> = new Set(),
    sharedRoot = ''
  ): Promise<void> {
    await fsp.mkdir(destination, { recursive: true })
    for (const dirent of await fsp.readdir(source, { withFileTypes: true })) {
      if (dirent.name === '.git' || isIgnoredDir(dirent.name)) continue
      const from = join(source, dirent.name)
      const to = join(destination, dirent.name)
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        // 共享目录不复制内容，改挂链接：成员能读能跑，但不占副本空间
        if (shared.has(rel)) {
          try {
            mkdirSync(dirname(to), { recursive: true })
            symlinkSync(join(sharedRoot, rel), to, process.platform === 'win32' ? 'junction' : 'dir')
          } catch {
            // 建链接失败时目录缺失，成员会在运行时发现；不影响其他文件
          }
          continue
        }
        await this.copyTreeAsync(from, to, budget, rel, shared, sharedRoot)
        continue
      }
      if (dirent.isSymbolicLink()) {
        try {
          const target = await fsp.readlink(from)
          let isDir = false
          try {
            isDir = (await fsp.stat(from)).isDirectory()
          } catch {
            isDir = false
          }
          await fsp.symlink(target, to, isDir && process.platform === 'win32' ? 'junction' : undefined)
        } catch {
          // 权限不允许创建链接时跳过；不把它当成可写文件
        }
        continue
      }
      if (!dirent.isFile()) continue
      const stat = await fsp.stat(from)
      budget.files += 1
      budget.bytes += stat.size
      if (budget.files > this.limits.maxFiles || budget.bytes > this.limits.maxBytes) {
        const limits = limitLabel(this.limits)
        throw new WorkspaceIsolationError(
          `必需文件复制时超过副本上限（${limits.files} 个文件 / ${limits.bytes}）。`,
          '大目录已自动改为共享链接；请把项目拆到更小的工作区后重试，本次任务不会在主工作区直接执行。'
        )
      }
      await fsp.mkdir(dirname(to), { recursive: true })
      await fsp.copyFile(from, to, fsConstants.COPYFILE_FICLONE)
      try {
        await fsp.utimes(to, stat.atime, stat.mtime)
      } catch {
        // 时间戳失败不影响内容
      }
    }
  }

  private linkIgnoredDirs(
    source: string,
    destination: string,
    prefix = ''
  ): void {
    let entries: Dirent[]
    try {
      entries = readdirSync(source, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of entries) {
      if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue
      if (dirent.name === '.git' || dirent.name === '.morrow') continue
      const from = join(source, dirent.name)
      const to = join(destination, dirent.name)
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name
      if (isIgnoredDir(dirent.name)) {
        if (NON_LINKED_DIRS.has(dirent.name) || dirent.name.startsWith('.morrow-runtime-')) continue
        if (existsSync(to)) continue
        try {
          mkdirSync(dirname(to), { recursive: true })
          symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir')
        } catch {
          // 链接失败时只是少一个依赖目录，不影响隔离写入
        }
        continue
      }
      this.linkIgnoredDirs(from, to, rel)
    }
  }

  /** 同一工作区并发 prepare 时共用一次源清单计算，避免 N 个协作成员各扫一遍全量文件。 */
  private readonly sourceManifests = new Map<string, Promise<PreparedSource>>()

  /**
   * 计算源清单。工作区超过上限时自动挑出最大的几块目录改为共享链接，
   * 让任何工作区都能进入协作流程，而不是报错让用户先去精简目录。
   */
  private async sourceManifest(source: string): Promise<PreparedSource> {
    const key = canonicalWorkspacePath(source)
    const running = this.sourceManifests.get(key)
    if (running) return running
    const task = (async (): Promise<PreparedSource> => {
      // 只 stat 的轻量统计先判断是否需要降级，避免先按完整清单扫一遍再重扫
      const tree = await this.measureDirs(source)
      const chosen = pickSharedDirs(tree, this.limits)
      const shared = new Set(chosen)
      if (shared.size > 0) {
        log.warn('workspace copy exceeds limit, sharing large dirs', {
          workspace: source,
          totalMB: Math.round(tree.bytes / (1024 * 1024)),
          totalFiles: tree.files,
          sharedDirs: chosen
        })
      }
      const manifest = await this.manifestAsync(source, shared)
      return { manifest, shared }
    })().catch(async (err: unknown) => {
      // 兜底：pickSharedDirs 挑不出足够候选时（大量小目录占满体积），按体积从大到小逐个共享，
      // 直到落进上限；源码目录始终跳过，保证成员的改动能合并回主工作区。
      if (!(err instanceof WorkspaceIsolationError)) throw err
      const tree = await this.measureDirs(source)
      const shared = new Set<string>()
      const candidates = [...tree.dirs]
        .filter((node) => !isProtectedPath(node.path))
        .sort((a, b) => b.bytes - a.bytes)
      const budget = this.limits.maxBytes * SHARE_HEADROOM
      const fileBudget = this.limits.maxFiles * SHARE_HEADROOM
      const protectedBytes = tree.dirs
        .filter((node) => isProtectedPath(node.path))
        .reduce((sum, node) => sum + node.bytes, 0)
      const protectedFiles = tree.dirs
        .filter((node) => isProtectedPath(node.path))
        .reduce((sum, node) => sum + node.files, 0)
      let bytes = tree.bytes
      let files = tree.files
      for (const node of candidates) {
        if (bytes <= budget && files <= fileBudget) break
        shared.add(node.path)
        bytes -= node.bytes
        files -= node.files
      }
      log.warn('workspace copy still too large, sharing dirs by size', {
        workspace: source,
        totalMB: Math.round(tree.bytes / (1024 * 1024)),
        sharedDirs: [...shared]
      })
      // 撤到只剩源码也放不下时，先确认是不是源码本身太大，给出准确原因
      if (protectedBytes > budget || protectedFiles > fileBudget) {
        throw new WorkspaceIsolationError(
          `工作区光是待改动的源码就有 ${Math.round(protectedBytes / (1024 * 1024))}MB、${protectedFiles} 个文件，超过副本上限。`,
          '大目录已自动改为共享链接，仍放不下说明源码本身超限；请把项目拆到更小的工作区里再执行。'
        )
      }
      const manifest = await this.manifestAsync(source, shared)
      return { manifest, shared }
    }).finally(() => {
      if (this.sourceManifests.get(key) === task) this.sourceManifests.delete(key)
    })
    this.sourceManifests.set(key, task)
    return task
  }

  /** 把源目录落到按内容命名、可被多个副本共用的基线目录上；已存在则直接复用。 */
  private async ensureBase(
    source: string,
    projectId: string,
    baseKey: string,
    manifest: Manifest,
    shared: ReadonlySet<string> = new Set(),
    sharedRoot = ''
  ): Promise<string> {
    const basePath = this.basePath(projectId, baseKey)
    const existing = this.readMarker(projectId, baseKey)
    if (existing && existing.hash === manifest.hash && existsSync(basePath)) return basePath
    if (existing && existing.hash !== manifest.hash) {
      // 指纹碰撞或标记与目录不符：丢掉旧基线，按内容重建
      rmSync(basePath, { recursive: true, force: true })
      rmSync(this.markerPath(projectId, baseKey), { force: true })
    }
    const staging = join(this.root(projectId), 'bases', `.tmp-${randomBytes(4).toString('hex')}`)
    try {
      await this.copyTreeAsync(source, staging, { files: 0, bytes: 0 }, '', shared, sharedRoot)
      mkdirSync(dirname(basePath), { recursive: true })
      try {
        renameSync(staging, basePath)
      } catch {
        // 另一个协作成员抢先发布了同一基线：直接复用它的结果
        rmSync(staging, { recursive: true, force: true })
        if (!existsSync(basePath)) throw new WorkspaceIsolationError('基线目录创建失败，已拒绝。', '请清理磁盘后重试。')
      }
      this.writeMarker(projectId, baseKey, {
        hash: manifest.hash,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        createdAt: Date.now()
      })
      return basePath
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      if (err instanceof WorkspaceIsolationError) throw err
      throw new WorkspaceIsolationError(
        `创建基线失败：${err instanceof Error ? err.message : String(err)}`,
        '本次任务不会在主工作区直接执行；请检查磁盘空间后重试。'
      )
    }
  }

  async prepare(input: {
    workspace: string
    projectId: string
    sessionId: string
    taskId: string
    attemptId: string
    label: string
  }): Promise<WorkspaceCopy> {
    const source = resolve(input.workspace)
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      throw new WorkspaceIsolationError('工作区不可访问，无法创建独立副本。', '请确认文件夹仍然存在后再试。')
    }
    const root = this.root(input.projectId)
    const copyId = `${input.taskId.slice(-12)}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`.replace(
      /[^A-Za-z0-9_-]/g,
      '_'
    )
    const copyPath = join(root, 'copies', copyId)
    if (!insideRoot(root, copyPath)) {
      throw new WorkspaceIsolationError('工作副本路径越界，已拒绝。', '请联系维护者检查数据目录。')
    }
    mkdirSync(dirname(copyPath), { recursive: true })
    let basePath = ''
    let worktreeCreated = false
    let preparingBaseKey: string | null = null
    try {
      // 先算源清单：同一基线只需落盘一次，后续协作成员复用同一份 base
      const prepared = await this.sourceManifest(source)
      const baseManifest = prepared.manifest
      const { shared } = prepared
      const baseKey = baseManifest.hash.slice(0, 32)
      basePath = await this.ensureBase(source, input.projectId, baseKey, baseManifest, shared, source)
      // 记录要等 copyTree 完成后才写；在这之前先占住基线，避免并行释放把它删掉。
      preparingBaseKey = this.preparingBaseKey(input.projectId, basePath)
      this.preparingBases.set(preparingBaseKey, (this.preparingBases.get(preparingBaseKey) ?? 0) + 1)

      const repo = runGit(source, ['rev-parse', '--show-toplevel'])
      const head = runGit(source, ['rev-parse', '--verify', 'HEAD'])
      let mode: 'git-worktree' | 'copy' = 'copy'
      let baseVersion = `copy:${baseManifest.hash.slice(0, 16)}`
      if (repo.ok && head.ok && samePath(repo.stdout.trim(), source)) {
        const worktree = runGit(source, ['worktree', 'add', '--detach', copyPath, 'HEAD'])
        if (worktree.ok) {
          mode = 'git-worktree'
          worktreeCreated = true
          baseVersion = `git:${head.stdout.trim().slice(0, 40)}`
          for (const dirent of readdirSync(copyPath, { withFileTypes: true })) {
            if (dirent.name === '.git') continue
            rmSync(join(copyPath, dirent.name), { recursive: true, force: true })
          }
        } else {
          rmSync(copyPath, { recursive: true, force: true })
        }
      }
      await this.copyTreeAsync(basePath, copyPath, { files: 0, bytes: 0 })
      this.linkIgnoredDirs(source, copyPath)

      const copy: CopyRecord = {
        copyId,
        projectId: input.projectId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        sourceWorkspace: source,
        path: copyPath,
        basePath,
        baseVersion,
        baselineHash: baseManifest.hash,
        mode,
        fileCount: baseManifest.fileCount,
        createdAt: Date.now(),
        ...(shared.size > 0 ? { sharedDirs: [...shared].sort() } : {}),
        baselineManifest: JSON.stringify(
          [...baseManifest.entries.values()].map((entry) => ({
            path: entry.path,
            kind: entry.kind,
            size: entry.size,
            hash: entry.hash
          }))
        )
      }
      this.saveRecord(copy)
      return copy
    } catch (err) {
      if (worktreeCreated) runGit(source, ['worktree', 'remove', '--force', copyPath], 30_000)
      rmSync(copyPath, { recursive: true, force: true })
      if (err instanceof WorkspaceIsolationError) throw err
      throw new WorkspaceIsolationError(
        `创建独立工作副本失败：${err instanceof Error ? err.message : String(err)}`,
        '本次任务不会在主工作区直接执行；请缩小工作区或检查磁盘空间后重试。'
      )
    } finally {
      if (preparingBaseKey) {
        const remaining = (this.preparingBases.get(preparingBaseKey) ?? 1) - 1
        if (remaining > 0) this.preparingBases.set(preparingBaseKey, remaining)
        else this.preparingBases.delete(preparingBaseKey)
      }
    }
  }

  private async mergeChain<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mergeChains.get(projectId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent
    })
    const tail = previous.then(() => current)
    this.mergeChains.set(projectId, tail)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.mergeChains.get(projectId) === tail) this.mergeChains.delete(projectId)
    }
  }

  private readonly mergeChains = new Map<string, Promise<void>>()

  /** 正在创建、尚未写入副本记录的基线引用数；防止并行释放提前删掉共享基线。 */
  private readonly preparingBases = new Map<string, number>()

  private preparingBaseKey(projectId: string, basePath: string): string {
    return `${projectId}|${canonicalWorkspacePath(basePath)}`
  }

  private async threeWayMerge(currentPath: string, basePath: string, incomingPath: string): Promise<string | null> {
    if (!isTextFile(currentPath) || !isTextFile(incomingPath) || !isTextFile(basePath)) return null
    const result = spawnSync('git', ['merge-file', '-p', currentPath, basePath, incomingPath], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    if (result.status === 0) return result.stdout ?? ''
    return null
  }

  private writeAtomic(target: string, data: string | Buffer): void {
    mkdirSync(dirname(target), { recursive: true })
    const temp = `${target}.morrow-merge-${process.pid}-${Date.now().toString(36)}`
    writeFileSync(temp, data)
    try {
      renameSync(temp, target)
    } catch {
      rmSync(target, { force: true })
      renameSync(temp, target)
    }
  }

  private currentHash(path: string): string | null {
    try {
      const stat = statSync(path)
      return stat.isFile() ? fileHash(path, stat) : null
    } catch {
      return null
    }
  }

  async merge(input: {
    copy: WorkspaceCopy
    projectId: string
    taskId: string
    attemptId: string
    label: string
  }): Promise<WorkspaceMergeResult> {
    return this.mergeChain(input.projectId, async () => {
      const copy = input.copy
      const mainRoot = resolve(copy.sourceWorkspace)
      if (!existsSync(copy.path) || !existsSync(copy.basePath)) {
        throw new WorkspaceIsolationError('工作副本或基线已丢失，无法合并。', '请重新执行这项任务；主工作区未被改动。')
      }
      const shared = new Set(copy.sharedDirs ?? [])
      const [base, incoming, main] = await Promise.all([
        this.manifestAsync(copy.basePath),
        this.manifestAsync(copy.path),
        // 主工作区可能远大于上限（那正是触发共享链接的原因）；合并只需比对，不受副本上限约束。
        // 共享目录直接跳过：它们是链接，成员对它的写入本就落在主工作区，不该再当成改动回写。
        this.manifestAsync(mainRoot, shared, { unlimited: true })
      ])
      // 共享目录是挂回主工作区的链接，成员对它的写入不经合并，也不会被当成改动回写
      const isSharedPath = (path: string): boolean => {
        if (shared.size === 0) return false
        const first = path.replace(/\\/g, '/')
        for (const dir of shared) {
          if (first === dir || first.startsWith(`${dir}/`)) return true
        }
        return false
      }
      const mainByKey = new Map([...main.entries.values()].map((entry) => [canonicalKey(entry.path), entry]))
      const baseByKey = new Map([...base.entries.values()].map((entry) => [canonicalKey(entry.path), entry]))
      const incomingByKey = new Map(
        [...incoming.entries.values()]
          .filter((entry) => !isSharedPath(entry.path))
          .map((entry) => [canonicalKey(entry.path), entry])
      )
      const keys = new Set([...baseByKey.keys(), ...incomingByKey.keys()])
      const applied: WorkspaceMergeApplied[] = []
      const conflicts: WorkspaceMergeConflict[] = []
      const withPreviews = (
        conflict: WorkspaceMergeConflict,
        mainEntry?: Entry,
        incomingEntry?: Entry
      ): WorkspaceMergeConflict => ({
        ...conflict,
        ...(mainEntry?.kind === 'file' ? { currentPreview: preview(readText(conflict.currentPath)) } : {}),
        ...(incomingEntry?.kind === 'file' ? { incomingPreview: preview(readText(conflict.incomingPath)) } : {})
      })

      for (const key of [...keys].sort()) {
        const baseEntry = baseByKey.get(key)
        const incomingEntry = incomingByKey.get(key)
        const mainEntry = mainByKey.get(key)
        const baseHash = baseEntry?.hash ?? null
        const incomingHash = incomingEntry?.hash ?? null
        const mainHash = mainEntry?.hash ?? null
        if (incomingHash === baseHash && Boolean(incomingEntry) === Boolean(baseEntry)) continue
        if (incomingEntry && baseEntry && incomingEntry.hash === baseEntry.hash) continue
        const displayPath = mainEntry?.path ?? incomingEntry?.path ?? baseEntry?.path ?? key
        // 共享目录内的文件不在隔离范围内，合并时直接跳过
        if (isSharedPath(displayPath)) continue
        const mainRelative = osRelative(mainEntry?.path ?? incomingEntry?.path ?? baseEntry?.path ?? key)
        const mainPath = resolve(mainRoot, mainRelative)
        if (!insideRoot(mainRoot, mainPath)) {
          conflicts.push(
            withPreviews(
              {
                path: displayPath,
                currentPath: mainPath,
                incomingPath: copy.path,
                ...(baseEntry ? { basePath: resolve(copy.basePath, osRelative(baseEntry.path)) } : {}),
                ...(baseEntry ? { baseHash: baseEntry.hash } : {}),
                ...(mainEntry ? { currentHash: mainEntry.hash } : {}),
                incomingHash: incomingEntry?.hash ?? '',
                reason: 'path-alias'
              },
              mainEntry,
              incomingEntry
            )
          )
          continue
        }

        const basePath = baseEntry ? resolve(copy.basePath, osRelative(baseEntry.path)) : undefined
        const incomingPath = incomingEntry ? resolve(copy.path, osRelative(incomingEntry.path)) : undefined
        const changedConcurrently = mainHash !== baseHash
        const sameAsIncoming = mainHash === incomingHash && Boolean(mainEntry) === Boolean(incomingEntry)

        if (!changedConcurrently || sameAsIncoming) {
          if (!incomingEntry) {
            if (mainEntry && this.currentHash(mainPath) === mainHash) {
              unlinkSync(mainPath)
              applied.push({ path: displayPath, action: 'deleted', afterHash: null })
            }
            continue
          }
          if (mainHash === incomingHash) continue
          if (this.currentHash(mainPath) !== mainHash) {
            conflicts.push(
              withPreviews(
                {
                  path: displayPath,
                  currentPath: mainPath,
                  incomingPath: incomingPath!,
                  ...(basePath ? { basePath } : {}),
                  ...(baseHash ? { baseHash } : {}),
                  ...(mainHash ? { currentHash: mainHash } : {}),
                  incomingHash: incomingHash!,
                  reason: 'content'
                },
                mainEntry,
                incomingEntry
              )
            )
            continue
          }
          const before = mainHash ? readText(mainPath) : ''
          const afterText = incomingEntry.kind === 'file' ? readText(incomingPath!) : ''
          if (incomingEntry.kind === 'symlink') {
            conflicts.push(
              withPreviews(
                {
                  path: displayPath,
                  currentPath: mainPath,
                  incomingPath: incomingPath!,
                  incomingHash: incomingHash!,
                  reason: 'binary'
                },
                mainEntry,
                incomingEntry
              )
            )
            continue
          }
          this.writeAtomic(mainPath, readFileSync(incomingPath!))
          const stats = lineStats(before, afterText)
          applied.push({
            path: displayPath,
            action: mainEntry ? 'modified' : 'created',
            afterHash: incomingHash!,
            ...stats
          })
          continue
        }

        // 两个方向都改了：能三路合并就合并，同一处冲突则保留两份。
        if (!incomingEntry || !mainEntry) {
          conflicts.push(
            withPreviews(
              {
                path: displayPath,
                currentPath: mainPath,
                incomingPath:
                  incomingPath ?? resolve(copy.path, osRelative(incomingEntry?.path ?? displayPath)),
                ...(basePath ? { basePath } : {}),
                ...(baseHash ? { baseHash } : {}),
                ...(mainHash ? { currentHash: mainHash } : {}),
                incomingHash: incomingHash ?? '',
                reason: baseHash ? 'delete' : 'create'
              },
              mainEntry,
              incomingEntry
            )
          )
          continue
        }
        if (incomingEntry.kind === 'symlink' || mainEntry.kind === 'symlink' || !basePath) {
          conflicts.push(
            withPreviews(
              {
                path: displayPath,
                currentPath: mainPath,
                incomingPath: incomingPath!,
                ...(basePath ? { basePath } : {}),
                baseHash: baseHash ?? undefined,
                currentHash: mainHash ?? undefined,
                incomingHash: incomingHash ?? '',
                reason: 'binary'
              },
              mainEntry,
              incomingEntry
            )
          )
          continue
        }
        const merged = await this.threeWayMerge(mainPath, basePath, incomingPath!)
        if (merged !== null && this.currentHash(mainPath) === mainHash) {
          const before = readText(mainPath)
          this.writeAtomic(mainPath, merged)
          const stats = lineStats(before, merged)
          applied.push({
            path: displayPath,
            action: 'modified',
            afterHash: sha256(merged),
            ...stats
          })
          continue
        }
        const pathAlias =
          mainEntry.path !== incomingEntry.path &&
          mainEntry.path.toLowerCase() === incomingEntry.path.toLowerCase()
        conflicts.push(
          withPreviews(
            {
              path: displayPath,
              currentPath: mainPath,
              incomingPath: incomingPath!,
              ...(basePath ? { basePath } : {}),
              ...(baseHash ? { baseHash } : {}),
              ...(mainHash ? { currentHash: mainHash } : {}),
              incomingHash: incomingHash!,
              reason: pathAlias ? 'path-alias' : 'content'
            },
            mainEntry,
            incomingEntry
          )
        )
      }

      const record = this.loadRecord(input.projectId, copy.copyId)
      if (record) {
        mkdirSync(dirname(this.recordPath(input.projectId, copy.copyId)), { recursive: true })
        writeFileSync(
          join(this.root(input.projectId), 'records', `${copy.copyId}.merge.json`),
          JSON.stringify(
            {
              projectId: input.projectId,
              taskId: input.taskId,
              attemptId: input.attemptId,
              label: input.label,
              mergedAt: Date.now(),
              applied,
              conflicts
            },
            null,
            2
          ),
          'utf8'
        )
      }
      return { copy, applied, conflicts }
    })
  }

  async resolveConflict(
    conflict: CollaborationConflict,
    choice: 'current' | 'incoming'
  ): Promise<{ ok: boolean; afterHash?: string | null; error?: string }> {
    if (conflict.status !== 'open') return { ok: false, error: '这条冲突已经处理过了。' }
    if (choice === 'current') return { ok: true }
    const currentHash = this.currentHash(conflict.currentPath)
    if (currentHash !== (conflict.currentHash ?? null)) {
      return { ok: false, error: '主文件在冲突后又发生了变化，请重新核对两份改动，避免覆盖新内容。' }
    }
    try {
      const incomingExists = existsSync(conflict.incomingPath)
      if (!incomingExists) {
        if (existsSync(conflict.currentPath)) unlinkSync(conflict.currentPath)
        return { ok: true, afterHash: null }
      }
      const data = readFileSync(conflict.incomingPath)
      this.writeAtomic(conflict.currentPath, data)
      return { ok: true, afterHash: sha256(data) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private removeCopyDir(copy: WorkspaceCopy): void {
    if (copy.mode === 'git-worktree') {
      const removed = runGit(copy.sourceWorkspace, ['worktree', 'remove', '--force', copy.path], 30_000)
      if (!removed.ok) rmSync(copy.path, { recursive: true, force: true })
    } else {
      rmSync(copy.path, { recursive: true, force: true })
    }
  }

  /** 释放一次任务占用的磁盘：删副本目录，最后一个使用者离开时再删共享基线。 */
  async discard(copy: WorkspaceCopy): Promise<void> {
    this.removeCopyDir(copy)
    if (copy.basePath && !this.baseStillReferenced(copy.projectId, copy.basePath, copy.copyId)) {
      rmSync(copy.basePath, { recursive: true, force: true })
      rmSync(this.markerPath(copy.projectId, basename(copy.basePath)), { force: true })
    }
    const record = this.loadRecord(copy.projectId, copy.copyId)
    if (record) this.saveRecord({ ...record, releasedAt: Date.now() })
  }

  /** 重试/换 attempt 时只拿得到 copyId，按记录找回副本再释放。找不到就当作已释放。 */
  async discardById(projectId: string, copyId: string): Promise<void> {
    const record = this.loadRecord(projectId, copyId)
    if (!record) return
    if (record.releasedAt) return
    try {
      await this.discard(record)
    } catch {
      // 目录可能已被用户手动删除；标记为已释放即可，避免下次重复尝试
      this.saveRecord({ ...record, releasedAt: Date.now() })
    }
  }

  /**
   * 回收项目内残留的副本：
   * - 记录标记已释放、目录却还在；
   * - 没有任何记录的孤儿目录（进程崩溃、用户强退留下的）；
   * - 长期无人引用的基线，以及复制中断留下的 .tmp-* 暂存目录。
   * 记录本身保留，冲突仍可凭记录追溯成员版本。
   */
  async prune(projectId: string, input: { now?: number; retentionMs?: number; activeCopyIds?: string[] } = {}): Promise<{
    removedCopies: string[]
    removedBases: string[]
    freedBytes: number
  }> {
    const now = input.now ?? Date.now()
    const retentionMs = input.retentionMs ?? RECORD_RETENTION_MS
    const active = new Set(input.activeCopyIds ?? [])
    const root = this.root(projectId)
    const records = this.allRecords(projectId)
    const removedCopies: string[] = []
    const removedBases: string[] = []
    let freedBytes = 0
    const sizeOf = (path: string): number => {
      try {
        return dirSize(path)
      } catch {
        return 0
      }
    }

    const copiesDir = join(root, 'copies')
    let copyNames: string[] = []
    try {
      copyNames = readdirSync(copiesDir)
    } catch {
      copyNames = []
    }
    /** 已合并且没有未解决冲突的副本：改动早已进主工作区，副本只是磁盘垃圾。 */
    const mergedCopyIds = new Set<string>()
    const conflictedCopyIds = new Set<string>()
    let mergeNames: string[] = []
    try {
      mergeNames = readdirSync(join(root, 'records'))
    } catch {
      mergeNames = []
    }
    for (const name of mergeNames) {
      if (!name.endsWith('.merge.json')) continue
      try {
        const merge = JSON.parse(readFileSync(join(root, 'records', name), 'utf8')) as {
          conflicts?: Array<{ status?: string }>
        }
        // 服务层写出的冲突没有 status 字段（由上层补充），未明确解决的都算未处理
        const unresolved = (merge.conflicts ?? []).filter(
          (conflict) => conflict.status !== 'resolved' && conflict.status !== 'current' && conflict.status !== 'incoming'
        )
        const id = name.replace(/\.merge\.json$/, '')
        if (unresolved.length === 0) mergedCopyIds.add(id)
        else conflictedCopyIds.add(id)
      } catch {
        // 合并记录损坏时不当作已合并，宁可多留一份
      }
    }
    for (const name of copyNames) {
      const dir = join(copiesDir, name)
      const record = records.find((entry) => entry.copyId === name)
      const createdAt = record?.createdAt ?? mtimeMs(dir)
      // 冲突未处理的副本不能动：冲突面板还要读它的成员版本文件（但显式释放的优先）
      const heldByConflict = conflictedCopyIds.has(name) && !mergedCopyIds.has(name) && !record?.releasedAt
      // 垃圾判定：已释放 / 无记录 / 已合并且无冲突 / 遗留超过保留期（失败、取消的任务）
      const stale =
        !active.has(name) &&
        !heldByConflict &&
        (!record ||
          Boolean(record.releasedAt) ||
          mergedCopyIds.has(name) ||
          (retentionMs > 0 && createdAt < now - retentionMs))
      if (!stale) continue
      freedBytes += sizeOf(dir)
      rmSync(dir, { recursive: true, force: true })
      removedCopies.push(name)
      if (record && !record.releasedAt) this.saveRecord({ ...record, releasedAt: now })
    }

    const basesDir = join(root, 'bases')
    let baseNames: string[] = []
    try {
      baseNames = readdirSync(basesDir)
    } catch {
      baseNames = []
    }
    // 引用关系以"目录真的还在"为准：记录刚被打上 releasedAt，不能再拿旧快照当依据
    const referencedBases = new Set(
      records
        .filter((record) => !record.releasedAt && record.copyId && !removedCopies.includes(record.copyId))
        .filter((record) => record.path && existsSync(record.path))
        .map((record) => canonicalWorkspacePath(record.basePath ?? ''))
    )
    for (const name of baseNames) {
      if (name === '.markers') continue
      const dir = join(basesDir, name)
      const isStaging = name.startsWith('.tmp-')
      const marker = isStaging ? null : this.readMarker(projectId, name)
      const referenced = referencedBases.has(canonicalWorkspacePath(dir))
      const oldEnough = isStaging
        ? mtimeMs(dir) < now - STAGING_TTL_MS
        : (marker?.createdAt ?? mtimeMs(dir)) < now - retentionMs
      if (referenced || !oldEnough) continue
      freedBytes += sizeOf(dir)
      rmSync(dir, { recursive: true, force: true })
      if (!isStaging) rmSync(this.markerPath(projectId, name), { force: true })
      removedBases.push(name)
    }

    // 记录超过保留期后连同 .merge.json 一起清掉，避免无限增长
    const recordsDir = join(root, 'records')
    let recordNames: string[] = []
    try {
      recordNames = readdirSync(recordsDir)
    } catch {
      recordNames = []
    }
    const releasedIds = new Set(records.filter((record) => record.releasedAt).map((record) => record.copyId))
    for (const name of recordNames) {
      const id = name.replace(/\.merge\.json$|\.json$/, '')
      if (!releasedIds.has(id)) continue
      const record = records.find((entry) => entry.copyId === id)
      if (!record?.releasedAt || record.releasedAt > now - retentionMs) continue
      rmSync(join(recordsDir, name), { force: true })
    }

    return { removedCopies, removedBases, freedBytes }
  }

  /** 读出本项目目录下所有 project_* 编号，用于启动时统一回收。 */
  projectsWithWorkspaces(): string[] {
    const base = join(this.dataDir ?? resolveDataDir(), 'collaboration', 'workspaces')
    try {
      return readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }

  /**
   * 启动/空闲时统一回收：进程崩溃、强退或旧版本留下的大量副本都靠这里收干净。
   * 只清理没有记录、已释放或超期的目录，运行中的副本由 activeCopyIds 保护。
   */
  async pruneAll(input: { now?: number; retentionMs?: number; activeCopyIds?: string[] } = {}): Promise<{
    removedCopies: number
    removedBases: number
    freedBytes: number
  }> {
    let removedCopies = 0
    let removedBases = 0
    let freedBytes = 0
    for (const projectId of this.projectsWithWorkspaces()) {
      try {
        const result = await this.prune(projectId, input)
        removedCopies += result.removedCopies.length
        removedBases += result.removedBases.length
        freedBytes += result.freedBytes
      } catch {
        // 单个项目目录损坏不影响其他项目
      }
    }
    return { removedCopies, removedBases, freedBytes }
  }
}

let instance: WorkspaceIsolationService | null = null

export function getWorkspaceIsolationService(): WorkspaceIsolationService {
  if (!instance) instance = new WorkspaceIsolationService()
  return instance
}
