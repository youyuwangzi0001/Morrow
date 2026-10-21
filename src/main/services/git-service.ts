/**
 * Git 工作台服务（P1-8）。
 *
 * 安全边界：
 * - 只操作「仓库根目录落在已登记工作区内」的仓库（feature 层先做工作区校验）；
 * - 所有路径由渲染层传入相对路径，规范化后拒绝绝对路径、`..`、NUL，并用
 *   `--literal-pathspecs` + `--` 交给 git，避免 pathspec 通配或参数注入；
 * - 只提供状态/差异/暂存/提交/分支/历史，不做 push/pull 等需要凭据的网络操作；
 * - 子进程无 shell、带超时与输出上限；提交禁用 GPG 签名，避免 pinentry 卡住应用。
 */
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitCommitResult,
  GitDiff,
  GitFileStatus,
  GitStatus
} from '../../shared/types'
import { assertInsideWorkspace, isPathInside } from '../features/workspace-roots'
import { log } from './logger'

const MAX_DIFF_BYTES = 400_000
const MAX_LOG = 80

function emptyStatus(isRepo = false, root: string | null = null): GitStatus {
  return {
    isRepo,
    root,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasCommits: false,
    files: [],
    stagedCount: 0,
    changedCount: 0
  }
}

interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

/** 外部环境可能带 GIT_DIR/GIT_WORK_TREE 等变量，会把命令重定向到工作区之外的仓库，必须剔除。 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM'
  ]) {
    delete env[key]
  }
  return env
}

function execGit(cwd: string, args: string[], timeoutMs: number): Promise<GitRunResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env: gitEnv()
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('未找到 git 命令，请先安装 Git 并确保它在 PATH 中。'))
          return
        }
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolvePromise({
          code,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr:
            typeof stderr === 'string'
              ? `${stderr}${error?.killed ? '\nGit 命令超时，已终止。' : ''}`
              : ''
        })
      }
    )
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** Windows 上 index.lock 常被并发的状态刷新短暂占用：重试几次再报错。 */
async function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitRunResult> {
  let result = await execGit(cwd, args, timeoutMs)
  for (let attempt = 0; attempt < 3 && result.code !== 0 && /index\.lock/i.test(result.stderr); attempt += 1) {
    await sleep(120 * (attempt + 1))
    result = await execGit(cwd, args, timeoutMs)
  }
  return result
}

/**
 * 某些 Windows 安全软件会阻止 git 子进程创建/覆盖工作区文件（错误为 Permission denied），
 * 但主进程自身可以写。此时用 Node 从索引取出内容（走 smudge 过滤器，兼容 LFS）写回，
 * 语义与 `git restore --worktree` 一致；符号链接与子模块不猜，直接报错。
 */
async function restoreWorktreeFromIndex(root: string, path: string): Promise<boolean> {
  const entry = await runGit(root, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', path])
  if (entry.code !== 0) return false
  const record = entry.stdout.split('\0').find(Boolean)
  const match = record ? /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t/.exec(record) : null
  if (!match) return false
  const mode = match[1]
  if (mode === '120000') throw new Error('符号链接不能在这里放弃改动，请使用终端还原。')
  if (mode === '160000') throw new Error('子模块不能在这里放弃改动，请使用终端处理。')
  const blob = await new Promise<Buffer | null>((resolvePromise) => {
    execFile(
      'git',
      ['cat-file', '--filters', `--path=${path}`, match[2]],
      { cwd: root, windowsHide: true, encoding: null, maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
      (error, stdout) => {
        if (error || !stdout) {
          resolvePromise(null)
          return
        }
        resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
      }
    )
  })
  if (!blob) return false
  const absolute = resolve(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, blob)
  // 手工写回不会更新索引里的 stat 缓存；内容与索引一致，add 只是刷新缓存
  const refresh = await runGit(root, ['--literal-pathspecs', 'add', '--', path])
  return refresh.code === 0
}

/** 还原文件时可能被安全软件或文件预览短暂占用：先重试，再走 Node 写回兜底。 */
async function restoreWorktree(root: string, path: string): Promise<GitRunResult> {
  let result = await runGit(root, ['--literal-pathspecs', 'restore', '--worktree', '--', path])
  for (
    let attempt = 0;
    attempt < 3 && result.code !== 0 && /permission denied|being used by another process|unable to create file|unable to unlink/i.test(result.stderr);
    attempt += 1
  ) {
    await sleep(150 * (attempt + 1))
    result = await runGit(root, ['--literal-pathspecs', 'restore', '--worktree', '--', path])
  }
  if (result.code === 0) return result
  if (!/permission denied|unable to create file|unable to unlink/i.test(result.stderr)) return result
  try {
    if (await restoreWorktreeFromIndex(root, path)) {
      log.warn('git restore fell back to index write', { path })
      return { code: 0, stdout: '', stderr: '' }
    }
  } catch (err) {
    log.warn('git restore fallback failed', { path, error: String(err) })
    throw err
  }
  return result
}

function gitError(result: GitRunResult): Error {
  const detail = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' ')
    .replace(/^fatal:\s*/, '')
    .slice(0, 600)
  return new Error(detail || 'Git 命令执行失败。')
}

function parseStatus(stdout: string): Pick<GitStatus, 'branch' | 'detached' | 'upstream' | 'ahead' | 'behind' | 'files' | 'stagedCount' | 'changedCount'> {
  const fields = stdout.split('\0')
  let branch: string | null = null
  let detached = false
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitFileStatus[] = []

  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]
    if (!entry) continue
    if (entry.startsWith('## ')) {
      const header = entry.slice(3)
      if (header === 'HEAD (no branch)') {
        detached = true
      } else if (header.startsWith('No commits yet on ')) {
        branch = header.slice('No commits yet on '.length).trim()
      } else if (header.startsWith('Initial commit on ')) {
        branch = header.slice('Initial commit on '.length).trim()
      } else {
        const [refPart, trackingPart = ''] = header.split(' [')
        const [local, remote] = refPart.split('...')
        branch = local || null
        upstream = remote || null
        ahead = Number(/ahead (\d+)/.exec(trackingPart)?.[1] ?? 0)
        behind = Number(/behind (\d+)/.exec(trackingPart)?.[1] ?? 0)
      }
      continue
    }
    if (entry.length < 4) continue
    const indexStatus = entry[0]
    const worktreeStatus = entry[1]
    if (indexStatus === '!' && worktreeStatus === '!') continue
    const path = entry.slice(3)
    let origPath: string | undefined
    if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
      origPath = fields[index + 1]
      index += 1
    }
    const untracked = indexStatus === '?' && worktreeStatus === '?'
    const conflicted =
      !untracked &&
      (indexStatus === 'U' ||
        worktreeStatus === 'U' ||
        (indexStatus === 'A' && worktreeStatus === 'A') ||
        (indexStatus === 'D' && worktreeStatus === 'D'))
    const staged = !untracked && !conflicted && indexStatus !== ' ' && indexStatus !== '?'
    const unstaged = untracked || (worktreeStatus !== ' ' && worktreeStatus !== '?')
    files.push({
      path,
      ...(origPath ? { origPath } : {}),
      indexStatus,
      worktreeStatus,
      staged,
      unstaged,
      untracked,
      conflicted
    })
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    branch,
    detached,
    upstream,
    ahead,
    behind,
    files,
    stagedCount: files.filter((file) => file.staged).length,
    changedCount: files.filter((file) => file.unstaged).length
  }
}

function trimDiff(output: string): { diff: string; truncated: boolean; binary: boolean } {
  const binary = /^Binary files .* differ$/m.test(output) || /^GIT binary patch$/m.test(output)
  if (output.length <= MAX_DIFF_BYTES) return { diff: output, truncated: false, binary }
  return { diff: output.slice(0, MAX_DIFF_BYTES), truncated: true, binary }
}

export class GitService {
  /** 返回仓库根；不是仓库时 null。仓库根在工作区之外时直接拒绝。 */
  private async repoRoot(workspace: string): Promise<string | null> {
    const result = await runGit(workspace, ['rev-parse', '--show-toplevel'])
    if (result.code !== 0) return null
    const raw = result.stdout.trim()
    if (!raw) return null
    let root: string
    try {
      root = realpathSync(raw)
    } catch {
      throw new Error('Git 仓库根目录不可访问。')
    }
    assertInsideWorkspace(workspace, root)
    return root
  }

  async status(workspace: string): Promise<GitStatus> {
    const root = await this.repoRoot(workspace)
    if (!root) return emptyStatus()
    const [hasCommits, status] = await Promise.all([
      runGit(root, ['rev-parse', '--verify', 'HEAD']),
      runGit(root, ['--literal-pathspecs', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])
    ])
    if (status.code !== 0) throw gitError(status)
    const parsed = parseStatus(status.stdout)
    return { isRepo: true, root, hasCommits: hasCommits.code === 0, ...parsed }
  }

  async init(workspace: string): Promise<GitStatus> {
    if (await this.repoRoot(workspace)) throw new Error('这个工作区已经是 Git 仓库。')
    // 某些 Windows 安全软件会阻止 git 从安装目录复制模板（description/hooks），
    // 先禁用模板；仍失败且是权限问题时，用 Node 生成最小合法 .git。
    let result = await runGit(workspace, ['init', '--template='])
    if (result.code !== 0) {
      result = await runGit(workspace, ['-c', 'init.templateDir=', 'init'])
    }
    if (result.code !== 0) {
      if (!/permission denied/i.test(result.stderr)) throw gitError(result)
      await this.createRepositoryManually(workspace)
      log.warn('git init fell back to manual .git creation', { workspace })
    }
    return this.status(workspace)
  }

  private async createRepositoryManually(workspace: string): Promise<void> {
    const root = resolve(workspace)
    const gitDir = join(root, '.git')
    for (const dir of ['objects/info', 'objects/pack', 'refs/heads', 'refs/tags', 'info']) {
      mkdirSync(join(gitDir, ...dir.split('/')), { recursive: true })
    }
    const configured = await runGit(root, ['config', '--get', 'init.defaultBranch'])
    const candidate = configured.code === 0 ? configured.stdout.trim() : ''
    const branch = /^[A-Za-z0-9._/-]{1,120}$/.test(candidate) && !candidate.startsWith('-') ? candidate : 'master'
    const head = join(gitDir, 'HEAD')
    if (!existsSync(head)) writeFileSync(head, `ref: refs/heads/${branch}\n`, 'utf8')
    const config = join(gitDir, 'config')
    if (!existsSync(config)) {
      writeFileSync(
        config,
        '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n\tlogallrefupdates = true\n',
        'utf8'
      )
    }
    const description = join(gitDir, 'description')
    if (!existsSync(description)) writeFileSync(description, '', 'utf8')
    const exclude = join(gitDir, 'info', 'exclude')
    if (!existsSync(exclude)) writeFileSync(exclude, '', 'utf8')
    const check = await runGit(root, ['rev-parse', '--is-inside-work-tree'])
    if (check.code !== 0) throw new Error('无法初始化 Git 仓库：文件系统拒绝写入 .git，请检查安全软件或权限设置。')
  }

  private normalizePath(root: string, raw: unknown): string {
    const value = typeof raw === 'string' ? raw.trim().replace(/\\/g, '/') : ''
    if (!value || value.includes('\0')) throw new Error('缺少文件路径。')
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error('只接受仓库内的相对路径。')
    const segments = value.split('/').filter((segment) => segment && segment !== '.')
    if (segments.length === 0 || segments.some((segment) => segment === '..')) {
      throw new Error('路径必须位于仓库内。')
    }
    const absolute = resolve(root, ...segments)
    if (!isPathInside(root, absolute)) throw new Error('路径必须位于仓库内。')
    return segments.join('/')
  }

  private async requireEntry(workspace: string, rawPath: unknown): Promise<{ status: GitStatus; root: string; entry: GitFileStatus; path: string }> {
    const status = await this.status(workspace)
    if (!status.isRepo || !status.root) throw new Error('当前工作区不是 Git 仓库。')
    const path = this.normalizePath(status.root, rawPath)
    const entry = status.files.find((file) => file.path === path)
    if (!entry) throw new Error('这个文件已不在 Git 变更列表中，请刷新后重试。')
    return { status, root: status.root, entry, path }
  }

  async diff(workspace: string, rawPath: unknown, staged: boolean): Promise<GitDiff> {
    const { root, entry, path } = await this.requireEntry(workspace, rawPath)
    let result: GitRunResult
    if (entry.untracked) {
      result = await runGit(root, ['--literal-pathspecs', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', path])
      // --no-index 发现差异时退出码为 1
      if (result.code !== 0 && result.code !== 1) throw gitError(result)
    } else if (staged) {
      result = await runGit(root, ['--literal-pathspecs', 'diff', '--cached', '--no-color', '--no-ext-diff', '--', path])
      if (result.code !== 0) throw gitError(result)
    } else {
      result = await runGit(root, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--', path])
      if (result.code !== 0) throw gitError(result)
    }
    const { diff, truncated, binary } = trimDiff(result.stdout)
    return { path, staged, diff, truncated, binary }
  }

  async stage(workspace: string, rawPath?: unknown): Promise<GitStatus> {
    if (rawPath === undefined) {
      const status = await this.status(workspace)
      if (!status.isRepo || !status.root) throw new Error('当前工作区不是 Git 仓库。')
      const result = await runGit(status.root, ['--literal-pathspecs', 'add', '-A', '--', '.'])
      if (result.code !== 0) throw gitError(result)
      return this.status(workspace)
    }
    if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error('文件路径无效。')
    const { root, path } = await this.requireEntry(workspace, rawPath)
    const result = await runGit(root, ['--literal-pathspecs', 'add', '-A', '--', path])
    if (result.code !== 0) throw gitError(result)
    return this.status(workspace)
  }

  async unstage(workspace: string, rawPath?: unknown): Promise<GitStatus> {
    if (rawPath === undefined) {
      const status = await this.status(workspace)
      if (!status.isRepo || !status.root) throw new Error('当前工作区不是 Git 仓库。')
      const restore = await runGit(status.root, ['--literal-pathspecs', 'restore', '--staged', '--', '.'])
      if (restore.code !== 0) {
        // 尚无 HEAD 时 restore 无法解析基线：从索引中移除（不删除工作区文件）
        const rm = await runGit(status.root, ['--literal-pathspecs', 'rm', '-r', '--cached', '--quiet', '--', '.'])
        if (rm.code !== 0) throw gitError(restore)
      }
      return this.status(workspace)
    }
    if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error('文件路径无效。')
    const { root, path, status } = await this.requireEntry(workspace, rawPath)
    const restore = status.hasCommits
      ? await runGit(root, ['--literal-pathspecs', 'restore', '--staged', '--', path])
      : await runGit(root, ['--literal-pathspecs', 'rm', '--cached', '--quiet', '--', path])
    if (restore.code !== 0) throw gitError(restore)
    return this.status(workspace)
  }

  async discard(workspace: string, rawPath: unknown): Promise<GitStatus> {
    const { root, entry, path } = await this.requireEntry(workspace, rawPath)
    if (entry.conflicted) throw new Error('这个文件有未解决的冲突，请在编辑器中处理后再操作。')
    if (entry.origPath) throw new Error('这个文件包含重命名，请在编辑器中处理后再操作。')
    if (entry.untracked) {
      const absolute = resolve(root, path)
      try {
        if (!isPathInside(root, realpathSync(dirname(absolute)))) throw new Error('父目录指向工作区之外。')
        const stat = lstatSync(absolute)
        if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('不是普通文件。')
      } catch {
        throw new Error('这个未跟踪文件已经不存在了，或位于工作区之外，请刷新。')
      }
      rmSync(absolute, { force: true, maxRetries: 4, retryDelay: 120 })
      return this.status(workspace)
    }
    const result = await restoreWorktree(root, path)
    if (result.code !== 0) throw gitError(result)
    return this.status(workspace)
  }

  async commit(workspace: string, rawMessage: string, stageAll: boolean): Promise<GitCommitResult> {
    const message = typeof rawMessage === 'string' ? rawMessage.trim() : ''
    if (!message) throw new Error('提交信息不能为空。')
    if (message.length > 5000) throw new Error('提交信息太长了（上限 5000 字）。')
    if (message.includes('\0')) throw new Error('提交信息包含非法字符。')
    let status = await this.status(workspace)
    if (!status.isRepo || !status.root) throw new Error('当前工作区不是 Git 仓库。')
    const root = status.root
    if (stageAll) {
      const add = await runGit(root, ['--literal-pathspecs', 'add', '-A', '--', '.'])
      if (add.code !== 0) throw gitError(add)
      status = await this.status(workspace)
    }
    if (status.stagedCount === 0) throw new Error('没有已暂存的改动。先暂存文件，或勾选「先暂存全部改动」。')
    const result = await runGit(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', message], 60_000)
    if (result.code !== 0) {
      if (/author identity unknown|unable to auto-detect email|empty ident/i.test(`${result.stdout}${result.stderr}`)) {
        throw new Error('还没有配置 Git 用户身份。请先在终端执行 git config user.name "你的名字" 与 git config user.email "你的邮箱"。')
      }
      throw gitError(result)
    }
    // 提交钩子也会写 stdout，用 log 取真实标题，避免提示里混入钩子输出
    const fallback = result.stdout.split(/\r?\n/).find((line) => line.trim()) ?? '已提交'
    const [hashResult, subjectResult] = await Promise.all([
      runGit(root, ['rev-parse', '--short', 'HEAD']),
      runGit(root, ['log', '-1', '--format=%s'])
    ])
    return {
      status: await this.status(workspace),
      commitHash: hashResult.code === 0 ? hashResult.stdout.trim() || null : null,
      summary: (subjectResult.code === 0 && subjectResult.stdout.trim() ? subjectResult.stdout.trim() : fallback).slice(0, 300)
    }
  }

  async branches(workspace: string): Promise<GitBranch[]> {
    const status = await this.status(workspace)
    if (!status.isRepo || !status.root) throw new Error('当前工作区不是 Git 仓库。')
    const result = await runGit(status.root, [
      'for-each-ref',
      '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(committerdate:unix)%00%(subject)',
      'refs/heads'
    ])
    if (result.code !== 0) throw gitError(result)
    const branches: GitBranch[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) continue
      const [name, head, upstream, date, subject] = line.split('\0')
      if (!name) continue
      const stamp = Number(date)
      branches.push({
        name,
        current: head === '*',
        upstream: upstream || null,
        lastCommitAt: Number.isFinite(stamp) && stamp > 0 ? stamp * 1000 : null,
        lastCommitSubject: subject ?? ''
      })
    }
    return branches.sort(
      (a, b) => Number(b.current) - Number(a.current) || (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0)
    )
  }

  async switchBranch(workspace: string, rawName: unknown): Promise<GitStatus> {
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    const branches = await this.branches(workspace)
    if (!branches.some((branch) => branch.name === name)) throw new Error('分支不存在，请刷新后重试。')
    if (branches.some((branch) => branch.name === name && branch.current)) return this.status(workspace)
    const status = await this.status(workspace)
    if (!status.root) throw new Error('当前工作区不是 Git 仓库。')
    let result = await runGit(status.root, ['switch', name])
    if (result.code !== 0 && /not a git command|unknown option/i.test(result.stderr)) {
      result = await runGit(status.root, ['checkout', name])
    }
    if (result.code !== 0) throw gitError(result)
    return this.status(workspace)
  }

  async createBranch(workspace: string, rawName: unknown): Promise<GitStatus> {
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    if (!name) throw new Error('分支名不能为空。')
    if (name.length > 200) throw new Error('分支名太长。')
    const status = await this.status(workspace)
    if (!status.isRepo || !status.root) throw new Error('当前工作区不是 Git 仓库。')
    const check = await runGit(status.root, ['check-ref-format', '--branch', name])
    if (check.code !== 0) throw new Error('分支名不合法：不能包含空格、~^:?*[\\ 等字符，也不能以 - 开头。')
    const result = await runGit(status.root, ['switch', '-c', name])
    if (result.code !== 0 && /not a git command|unknown option/i.test(result.stderr)) {
      const fallback = await runGit(status.root, ['checkout', '-b', name])
      if (fallback.code !== 0) throw gitError(fallback)
    } else if (result.code !== 0) {
      throw gitError(result)
    }
    return this.status(workspace)
  }

  async log(workspace: string): Promise<GitCommit[]> {
    const status = await this.status(workspace)
    if (!status.isRepo || !status.root) throw new Error('当前工作区不是 Git 仓库。')
    if (!status.hasCommits) return []
    const result = await runGit(status.root, [
      'log',
      `--max-count=${MAX_LOG}`,
      '--date=unix',
      '--format=%H%x00%h%x00%an%x00%ad%x00%s'
    ])
    if (result.code !== 0) throw gitError(result)
    const commits: GitCommit[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) continue
      const [hash, shortHash, author, date, subject] = line.split('\0')
      if (!hash) continue
      const stamp = Number(date)
      commits.push({
        hash,
        shortHash: shortHash || hash.slice(0, 7),
        author: author || '',
        date: Number.isFinite(stamp) ? stamp * 1000 : 0,
        subject: subject || ''
      })
    }
    return commits
  }

  async show(workspace: string, rawHash: unknown): Promise<GitCommitDetail> {
    const hash = typeof rawHash === 'string' ? rawHash.trim() : ''
    if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw new Error('提交哈希不合法。')
    const status = await this.status(workspace)
    if (!status.isRepo || !status.root) throw new Error('当前工作区不是 Git 仓库。')
    if (!status.hasCommits) throw new Error('这个仓库还没有提交。')
    const meta = await runGit(status.root, [
      'show',
      '-s',
      '--date=unix',
      '--format=%H%x00%h%x00%an%x00%ad%x00%s%x00%b',
      hash
    ])
    if (meta.code !== 0) throw gitError(meta)
    const parts = meta.stdout.split('\0')
    const [fullHash, shortHash, author, date, subject, ...bodyParts] = parts
    const stamp = Number(date)
    const patch = await runGit(status.root, ['show', '--format=', '--patch', '--no-color', '--no-ext-diff', hash])
    if (patch.code !== 0) throw gitError(patch)
    const { diff, truncated } = trimDiff(patch.stdout.replace(/^\n+/, ''))
    return {
      commit: {
        hash: fullHash || hash,
        shortHash: shortHash || hash.slice(0, 7),
        author: author || '',
        date: Number.isFinite(stamp) ? stamp * 1000 : 0,
        subject: subject || ''
      },
      body: bodyParts.join('\0').trim(),
      diff,
      truncated
    }
  }
}

export const gitService = new GitService()
