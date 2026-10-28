// 所有 feature IPC、Git 服务与主进程模块装配。
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, basename, isAbsolute, extname, relative } from 'node:path'
import type { GitBranch, GitCommit, GitCommitDetail, GitCommitResult, GitDiff, GitFileStatus, GitIdentity, GitStatus, Session, SessionMeta, PermissionRuleKind } from '../shared/types'
import { log } from './logger'
import type { HistorySource, SearchQueryInput } from './workspace'
import { isPathInside, dataPath, EditorHistoryStore, describeFilePreview, convertDocumentToPreview, convertDocxToHtml, convertPptxToPreview, convertXlsxToPreview, listArchive, WorkspaceFileError, createWorkspaceEntry, deleteWorkspaceEntry, findWorkspaceContaining, inspectWorkspaceEntry, listWorkspaceEntries, moveWorkspaceEntry, readWorkspaceFile, renameWorkspaceEntry, statWorkspaceFile, writeWorkspaceFile, revealInFileManager, openPathFromUserShell, resolveDataDir, ensureDataDirs, WorkspaceSearchService, cleanTargetDataDir, copyUserDataForMigration, isNestedPath, readStudioLocation, removeStudioLocation, resolveDefaultStudioRoot, samePath, studioDataDirInfo, writeStudioLocation } from './workspace'
import { getSettingsStore } from './settings'
import { getSessionStore } from './session'
import type { IpcMainInvokeEvent } from 'electron'
import { app, nativeImage, BrowserWindow, dialog } from 'electron'
import { registerFeatureHandler, sendFeatureEvent } from './feature-ipc'
import { BrowserService, browserService } from './artifacts'
import type { BrowserBridge } from '../core/util'
import { setBrowserBridge } from '../core/util'
import type { ConnectorSaveInput, ConnectorScope, ConnectorSecretInput } from './memory'
import { deleteConnector, getConnector, getConnectorCatalog, getConnectorPaths, connectorOAuthStatus, detectConnectorRuntime, installCatalogConnector, revokeConnectorOAuth, startConnectorOAuth, listConnectorTools, listConnectors, saveConnector, setConnectorEnabled, testConnector, trustWorkspaceConfig } from './memory'
import { copyFile } from 'node:fs/promises'
import { getMediaService, getMediaCatalog } from './media'
import type { MediaCatalogAction } from '../shared/studio'
import type { MemoryScope, SkillsFeatureEffects } from './memory'
import { MemoryService, configureMemoryRuntime, getMemoryInjection, createSkillsFeatureHandlers, createSkillsService, installSkillsRuntimeEnv } from './memory'
import type { SubscriptionAction } from '../shared/contracts'
import { EPISODE_CHANGED_EVENT, EVOLUTION_CHANGED_EVENT, MEMORY_CHANGED_EVENT } from '../shared/contracts'
import type { SideChatHistoryItem } from './agent'
import { configureEvolutionRuntime, getEvolutionService, getAgentService, runSideChat, ensureBuiltinSkills, discoverAgentRules, loadAgentRoles, summarizeAgentRoles } from './agent'
import type { ProjectContextOptions, ProjectCreateInput, ProjectKnowledgeInfo, ProjectUpdateInput } from './runtime'
import { ProjectService, configureProjectsRuntime, getProjectContext, normalizeProjectWorkspace, setSearchClearHandler, setSearchInvalidationHandler, recordTokenUsage, discoverCustomCommands, getPermissionRulesService } from './runtime'
import { randomUUID } from 'node:crypto'
import { estimateTokens } from '@core/index'
import { getStudioService } from './studio'
import { getStudioStore, resetStudioStoreForTest } from './studio'
import { homedir } from 'node:os'
import { getTerminalManager } from './terminal-manager'
import { scheduledInputFromRecord, createSchedule, listSchedules, removeSchedule, runScheduleNow, setScheduleEnabled, updateSchedule } from './schedules'
import { getSubscriptionService, runSubscriptionAction, getQoderSubscriptionService } from './subscriptions'
import { closeLoginWindow } from './workspace'



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
    changedCount: 0,
    identity: { name: null, email: null, configured: false }
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

  /** user.name / user.email：本地仓库优先，其次全局；缺一即视为未配置。 */
  private async readIdentity(root: string): Promise<GitIdentity> {
    const [nameResult, emailResult] = await Promise.all([
      runGit(root, ['config', '--get', 'user.name']),
      runGit(root, ['config', '--get', 'user.email'])
    ])
    const name = nameResult.code === 0 ? nameResult.stdout.trim() : ''
    const email = emailResult.code === 0 ? emailResult.stdout.trim() : ''
    return { name: name || null, email: email || null, configured: Boolean(name && email) }
  }

  async status(workspace: string): Promise<GitStatus> {
    const root = await this.repoRoot(workspace)
    if (!root) return emptyStatus()
    const [hasCommits, status, identity] = await Promise.all([
      runGit(root, ['rev-parse', '--verify', 'HEAD']),
      runGit(root, ['--literal-pathspecs', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']),
      this.readIdentity(root)
    ])
    if (status.code !== 0) throw gitError(status)
    const parsed = parseStatus(status.stdout)
    return { isRepo: true, root, hasCommits: hasCommits.code === 0, ...parsed, identity }
  }

  /** 首次提交前在界面里设置身份：只写当前仓库的 .git/config，不改全局配置。 */
  async setIdentity(workspace: string, rawName: unknown, rawEmail: unknown): Promise<GitStatus> {
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    const email = typeof rawEmail === 'string' ? rawEmail.trim() : ''
    if (!name) throw new Error('Git 用户名不能为空。')
    if (name.length > 80 || /[\0\r\n]/.test(name) || name.startsWith('-')) throw new Error('Git 用户名不合法。')
    if (!email || email.length > 200 || /[\0\r\n\s]/.test(email) || email.startsWith('-') || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      throw new Error('Git 邮箱格式不合法。')
    }
    const status = await this.status(workspace)
    if (!status.isRepo || !status.root) throw new Error('当前工作区不是 Git 仓库。')
    const root = status.root
    const nameResult = await runGit(root, ['config', '--local', '--replace-all', 'user.name', name])
    if (nameResult.code !== 0) throw gitError(nameResult)
    const emailResult = await runGit(root, ['config', '--local', '--replace-all', 'user.email', email])
    if (emailResult.code !== 0) throw gitError(emailResult)
    return this.status(workspace)
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




export { isPathInside }



export function knownWorkspaceRoots(): string[] {
  const roots: string[] = []
  try {
    const settings = getSettingsStore().get()
    if (settings.lastWorkspace) roots.push(settings.lastWorkspace)
    roots.push(...settings.recentWorkspaces)
  } catch {
  }
  try {
    for (const session of getSessionStore().list()) {
      if (session.workspace) roots.push(session.workspace)
    }
  } catch {
  }
  return [...new Set(roots.map((root) => resolve(root)))]
}



/** 把请求目录解析成已登记工作区内的真实路径；默认取第一个工作区。 */
export function resolveWorkspaceDir(raw: unknown, outsideMessage: string): string {
  const roots = knownWorkspaceRoots()
  const requested = typeof raw === 'string' ? raw.trim() : ''
  if (!requested) {
    const first = roots[0]
    if (first) return realpathSync(first)
    throw new Error('还没有选择工作文件夹。')
  }
  const target = resolve(requested)
  let real: string
  try {
    real = realpathSync(target)
    if (!statSync(real).isDirectory()) throw new Error('not dir')
  } catch {
    throw new Error('工作目录不存在或不可访问。')
  }
  for (const root of roots) {
    try {
      if (isPathInside(realpathSync(root), real)) return real
    } catch {
      // try next
    }
  }
  throw new Error(outsideMessage)
}



/** 校验某个仓库根目录仍落在指定工作区内（防止向上发现工作区之外的仓库）。 */
export function assertInsideWorkspace(workspace: string, target: string): void {
  const realWorkspace = realpathSync(workspace)
  const realTarget = realpathSync(target)
  if (!isPathInside(realWorkspace, realTarget)) {
    throw new Error('当前文件夹位于一个更大的 Git 仓库中（仓库根目录在工作区之外）。请直接把仓库根目录作为工作区打开，以免误操作工作区外的文件。')
  }
}



function asRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') throw new Error('参数格式错误：需要一个对象。')
  return payload as Record<string, unknown>
}



function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`参数 ${key} 必须是非空字符串。`)
  return value
}



/** 自动化 bridge 实现（core 工具只依赖接口，主进程在这里落到 BrowserService） */
export const browserAutomationBridge: BrowserBridge = {
  open: (url, ctx) => browserService.automationOpen(url, ctx),
  click: (target, ctx) => browserService.automationClick(target, ctx),
  type: (target, text, ctx) => browserService.automationType(target, text, ctx),
  read: (ctx) => browserService.automationRead(ctx),
  screenshot: (ctx) => browserService.automationScreenshot(ctx),
  back: (ctx) => browserService.automationBack(ctx),
  forward: (ctx) => browserService.automationForward(ctx),
  reload: (ctx) => browserService.automationReload(ctx),
  scroll: (ctx, deltaY) => browserService.automationScroll(ctx, deltaY),
  closeAutomation: () => browserService.closeAutomation()
}



let featureInstalled = false



/**
 * 一次性初始化：注册 IPC、注入 core bridge，并在 app ready 后配置安全 session。
 *
 * 注意：electron-vite 会把 `require('./features')` 内联成静态 import，模块副作用可能在
 * app ready 之前执行；`session.fromPartition` 在 ready 前会抛
 * "Session can only be received when app is ready"。因此 handler 注册与 bridge 注入
 * 保持同步（安全），BrowserService.initialize() 延迟到 app ready。
 */
export function installBrowserFeature(service: BrowserService = browserService): void {
  if (featureInstalled) return
  featureInstalled = true
  setBrowserBridge(browserAutomationBridge)
  const initService = (): void => {
    try {
      service.initialize()
    } catch (err) {
      log.error('browser feature initialize failed', String(err))
    }
  }
  if (app.isReady()) initService()
  else void app.whenReady().then(initService)

  registerFeatureHandler('feature:browser:get-state', () => service.getState())
  registerFeatureHandler('feature:browser:open', (payload, event) => {
    const data = asRecord(payload)
    return service.openSurface(readString(data, 'url'), event, data.bounds)
  })
  registerFeatureHandler('feature:browser:open-preview', (payload, event) => {
    const data = asRecord(payload)
    return service.openPreview(readString(data, 'url'), event, data.bounds)
  })
  registerFeatureHandler('feature:browser:navigate', (payload) => {
    const data = asRecord(payload)
    return service.navigate(readString(data, 'url'))
  })
  registerFeatureHandler('feature:browser:tab-new', (payload, event) => {
    const data = asRecord(payload ?? {})
    const url = typeof data.url === 'string' ? data.url : ''
    return service.newTab(event, url, data.bounds)
  })
  registerFeatureHandler('feature:browser:tab-activate', (payload) => {
    const data = asRecord(payload)
    return service.activateTab(readString(data, 'id'))
  })
  registerFeatureHandler('feature:browser:tab-close', (payload) => {
    const data = asRecord(payload)
    return service.closeTab(readString(data, 'id'))
  })
  registerFeatureHandler('feature:browser:set-bounds', (payload) => {
    const data = asRecord(payload)
    return service.setBounds(data)
  })
  registerFeatureHandler('feature:browser:set-visible', (payload) => {
    const data = asRecord(payload)
    service.setVisible(data.visible === true)
    return service.getState()
  })
  registerFeatureHandler('feature:browser:back', () => service.back())
  registerFeatureHandler('feature:browser:forward', () => service.forward())
  registerFeatureHandler('feature:browser:reload', () => service.reload())
  registerFeatureHandler('feature:browser:stop', () => service.stop())
  registerFeatureHandler('feature:browser:close', () => {
    service.closeSurface()
    return service.getState()
  })
  registerFeatureHandler('feature:browser:decide-download', (payload) => {
    const data = asRecord(payload)
    const id = readString(data, 'id')
    service.decideDownload(id, data.allow === true)
    return { decided: true, allow: data.allow === true }
  })
  registerFeatureHandler('feature:browser:reveal-download', async (payload) => {
    const data = asRecord(payload)
    await service.revealDownload(readString(data, 'path'))
    return { revealed: true }
  })
  registerFeatureHandler('feature:browser:debug-info', () => {
    const testMode = process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')
    if (!testMode) throw new Error('debug 信息仅在测试模式可用。')
    return service.debugInfo()
  })

  log.info('browser feature installed', { channels: 17 })
}



// 由 Lead 的 features/index.ts 在 app ready 后调用 registerFeatureModules()，
// 避免在 Electron app ready 前创建 session。
export function registerBrowserFeature(): void {
  installBrowserFeature()
}



export { browserService }


export type { BrowserState } from '../core/util'



/** 频道清单：Lead 集成/测试/文档共用（避免手写字符串漂移） */
export const CONNECTOR_CHANNELS = {
  list: 'feature:connectors:list',
  get: 'feature:connectors:get',
  save: 'feature:connectors:save',
  delete: 'feature:connectors:delete',
  setEnabled: 'feature:connectors:set-enabled',
  test: 'feature:connectors:test',
  tools: 'feature:connectors:tools',
  catalog: 'feature:connectors:catalog',
  runtime: 'feature:connectors:runtime',
  install: 'feature:connectors:install',
  paths: 'feature:connectors:paths',
  trustWorkspace: 'feature:connectors:trust-workspace',
  secretStatus: 'feature:connectors:secret-status',
  oauthStart: 'feature:connectors:oauth-start',
  oauthStatus: 'feature:connectors:oauth-status',
  oauthRevoke: 'feature:connectors:oauth-revoke'
} as const



export type ConnectorChannel = (typeof CONNECTOR_CHANNELS)[keyof typeof CONNECTOR_CHANNELS]



function connectorsAsRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('参数格式错误：payload 必须是一个对象。')
  }
  return payload as Record<string, unknown>
}



function readScope(payload: Record<string, unknown>): ConnectorScope {
  if (payload.scope === 'workspace') return 'workspace'
  if (payload.scope === 'user' || payload.scope === undefined || payload.scope === null) return 'user'
  throw new Error('scope 只能是 "user" 或 "workspace"。')
}



function readWorkspace(payload: Record<string, unknown>, scope: ConnectorScope): string | null {
  if (scope !== 'workspace') return null
  const workspace = payload.workspace
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('工作区级连接器需要 workspace 路径。')
  if (workspace.length > 4096) throw new Error('workspace 路径过长。')
  return resolveWorkspaceDir(workspace, '工作区级连接器只能操作已登记的工作区。')
}



function connectorsReadString(payload: Record<string, unknown>, key: string, options: { required?: boolean; max?: number } = {}): string | undefined {
  const value = payload[key]
  if (value === undefined || value === null || value === '') {
    if (options.required) throw new Error(`缺少必填参数「${key}」。`)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(`参数「${key}」应该是字符串。`)
  const trimmed = value.trim()
  if (options.required && !trimmed) throw new Error(`参数「${key}」不能为空。`)
  if (options.max && trimmed.length > options.max) throw new Error(`参数「${key}」过长（上限 ${options.max} 字符）。`)
  return trimmed
}



function readNumber(payload: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = payload[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`参数「${key}」应该是数字。`)
  if (value < min || value > max) throw new Error(`参数「${key}」超出范围（${min}–${max}）。`)
  return value
}



function readBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`参数「${key}」应该是布尔值。`)
  return value
}



function readStringArray(payload: Record<string, unknown>, key: string, maxItems = 64, maxLength = 4096): string[] | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    // 兼容 UI 多行文本：按行切分，忽略空行
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, maxItems)
      .map((line) => {
        if (line.length > maxLength) throw new Error(`args 单行过长（上限 ${maxLength} 字符）。`)
        return line
      })
  }
  if (!Array.isArray(value)) throw new Error(`参数「${key}」应该是字符串数组。`)
  if (value.length > maxItems) throw new Error(`参数「${key}」数量过多（上限 ${maxItems}）。`)
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(`参数「${key}」数组里只能包含字符串。`)
    if (item.length > maxLength) throw new Error(`参数「${key}」单个元素过长（上限 ${maxLength} 字符）。`)
    return item
  })
}



function readSecretFields(payload: Record<string, unknown>, key: 'env' | 'headers'): ConnectorSecretInput[] | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`参数「${key}」应该是数组。`)
  if (value.length > 64) throw new Error(`参数「${key}」条目过多（上限 64 个）。`)
  const fields: ConnectorSecretInput[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`参数「${key}」的每一项都应该是对象。`)
    const record = item as Record<string, unknown>
    if (typeof record.key !== 'string' || !record.key.trim()) throw new Error(`参数「${key}」的 key 不能为空。`)
    if (record.value !== undefined && record.value !== null && typeof record.value !== 'string') {
      throw new Error(`参数「${key}.${record.key}」的 value 应该是字符串。`)
    }
    if (typeof record.value === 'string' && record.value.length > 8192) throw new Error(`参数「${key}.${record.key}」的 value 过长。`)
    fields.push({ key: record.key.trim(), ...(typeof record.value === 'string' ? { value: record.value } : {}) })
  }
  return fields
}



function readSaveInput(payload: Record<string, unknown>, scope: ConnectorScope, workspace: string | null): ConnectorSaveInput {
  const transportRaw = payload.transport
  if (transportRaw !== undefined && transportRaw !== null && transportRaw !== 'stdio' && transportRaw !== 'http' && transportRaw !== 'sse' && transportRaw !== 'streamable-http') {
    throw new Error('transport 只能是 stdio / http / sse。')
  }
  const env = readSecretFields(payload, 'env')
  const headers = readSecretFields(payload, 'headers')
  let oauth: ConnectorSaveInput['oauth']
  if (payload.oauth === null) {
    oauth = null
  } else if (payload.oauth !== undefined) {
    const raw = payload.oauth
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数「oauth」应该是一个对象或 null。')
    const record = raw as Record<string, unknown>
    const authorizationUrl = connectorsReadString(record, 'authorizationUrl', { max: 2048 })
    const tokenUrl = connectorsReadString(record, 'tokenUrl', { max: 2048 })
    const clientId = connectorsReadString(record, 'clientId', { max: 300 })
    if (authorizationUrl || tokenUrl || clientId) {
      if (!authorizationUrl || !tokenUrl || !clientId) {
        throw new Error('OAuth 需要同时提供 authorizationUrl、tokenUrl 与 clientId。')
      }
      oauth = {
        authorizationUrl,
        tokenUrl,
        clientId,
        ...(readStringArray(record, 'scopes') ? { scopes: readStringArray(record, 'scopes')!.slice(0, 20) } : {})
      }
    }
  }
  return {
    scope,
    ...(workspace ? { workspace } : {}),
    ...(typeof payload.originalName === 'string' && payload.originalName.trim() ? { originalName: payload.originalName.trim() } : {}),
    name: connectorsReadString(payload, 'name', { required: true, max: 64 }) as string,
    ...(transportRaw ? { transport: transportRaw as ConnectorSaveInput['transport'] } : {}),
    ...(connectorsReadString(payload, 'command', { max: 1024 }) ? { command: connectorsReadString(payload, 'command', { max: 1024 }) } : {}),
    ...(readStringArray(payload, 'args') ? { args: readStringArray(payload, 'args') } : {}),
    ...(connectorsReadString(payload, 'cwd', { max: 4096 }) ? { cwd: connectorsReadString(payload, 'cwd', { max: 4096 }) } : {}),
    ...(connectorsReadString(payload, 'url', { max: 2048 }) ? { url: connectorsReadString(payload, 'url', { max: 2048 }) } : {}),
    ...(connectorsReadString(payload, 'description', { max: 500 }) ? { description: connectorsReadString(payload, 'description', { max: 500 }) } : {}),
    ...(env ? { env } : {}),
    ...(headers ? { headers } : {}),
    ...(readNumber(payload, 'timeoutMs', 250, 120_000) !== undefined ? { timeoutMs: readNumber(payload, 'timeoutMs', 250, 120_000) } : {}),
    ...(readNumber(payload, 'retries', 0, 5) !== undefined ? { retries: readNumber(payload, 'retries', 0, 5) } : {}),
    ...(readBoolean(payload, 'allowPrivateNetwork') !== undefined ? { allowPrivateNetwork: readBoolean(payload, 'allowPrivateNetwork') } : {}),
    ...(readBoolean(payload, 'enabled') !== undefined ? { enabled: readBoolean(payload, 'enabled') } : {}),
    ...(oauth !== undefined ? { oauth } : {})
  }
}



registerFeatureHandler(CONNECTOR_CHANNELS.list, (payload) => {
  const record = connectorsAsRecord(payload)
  const scope = readScope(record)
  return listConnectors(scope, readWorkspace(record, scope))
})



registerFeatureHandler(CONNECTOR_CHANNELS.get, (payload) => {
  const record = connectorsAsRecord(payload)
  const scope = readScope(record)
  const name = connectorsReadString(record, 'name', { required: true, max: 64 }) as string
  return getConnector(scope, name, readWorkspace(record, scope))
})



registerFeatureHandler(CONNECTOR_CHANNELS.save, (payload) => {
  const record = connectorsAsRecord(payload)
  const scope = readScope(record)
  return saveConnector(readSaveInput(record, scope, readWorkspace(record, scope)))
})



registerFeatureHandler(CONNECTOR_CHANNELS.delete, (payload) => {
  const record = connectorsAsRecord(payload)
  const scope = readScope(record)
  const name = connectorsReadString(record, 'name', { required: true, max: 64 }) as string
  return deleteConnector(scope, name, readWorkspace(record, scope))
})



registerFeatureHandler(CONNECTOR_CHANNELS.setEnabled, (payload) => {
  const record = connectorsAsRecord(payload)
  const scope = readScope(record)
  const name = connectorsReadString(record, 'name', { required: true, max: 64 }) as string
  const enabled = readBoolean(record, 'enabled')
  if (enabled === undefined) throw new Error('缺少必填参数「enabled」。')
  return setConnectorEnabled(scope, name, enabled, readWorkspace(record, scope))
})



registerFeatureHandler(CONNECTOR_CHANNELS.test, (payload) => {
  const record = connectorsAsRecord(payload)
  const scope = readScope(record)
  const workspace = readWorkspace(record, scope)
  const name = connectorsReadString(record, 'name', { max: 64 })
  const draft = record.draft
  if (!name && !draft) throw new Error('测试连接需要 name（已保存的连接器）或 draft（未保存的草稿）。')
  if (draft !== undefined && (!draft || typeof draft !== 'object' || Array.isArray(draft))) {
    throw new Error('参数「draft」应该是一个对象。')
  }
  return testConnector({
    scope,
    ...(workspace ? { workspace } : {}),
    ...(name ? { name } : {}),
    ...(draft ? { draft: draft as Record<string, unknown> } : {})
  })
})



registerFeatureHandler(CONNECTOR_CHANNELS.tools, (payload) => {
  const record = connectorsAsRecord(payload)
  const scope = readScope(record)
  const name = connectorsReadString(record, 'name', { required: true, max: 64 }) as string
  return listConnectorTools(scope, name, readWorkspace(record, scope))
})



registerFeatureHandler(CONNECTOR_CHANNELS.catalog, () => ({ entries: getConnectorCatalog() }))



registerFeatureHandler(CONNECTOR_CHANNELS.runtime, (payload) => {
  if (payload === undefined || payload === null) return detectConnectorRuntime()
  const record = connectorsAsRecord(payload)
  if (record.force !== undefined && typeof record.force !== 'boolean') throw new Error('force 必须是布尔值。')
  return detectConnectorRuntime(record.force === true)
})



registerFeatureHandler(CONNECTOR_CHANNELS.install, async (payload) => {
  const record = connectorsAsRecord(payload)
  const scope = readScope(record)
  const id = connectorsReadString(record, 'id', { required: true, max: 64 }) as string
  const token = connectorsReadString(record, 'token', { max: 8192 })
  const folder = connectorsReadString(record, 'folder', { max: 4096 })
  if (record.test !== undefined && typeof record.test !== 'boolean') throw new Error('test 必须是布尔值。')
  return installCatalogConnector({
    scope,
    ...(scope === 'workspace' ? { workspace: readWorkspace(record, scope) } : {}),
    id,
    ...(token ? { token } : {}),
    ...(folder ? { folder } : {}),
    test: record.test !== false
  })
})



registerFeatureHandler(CONNECTOR_CHANNELS.paths, (payload) => {
  const record = connectorsAsRecord(payload)
  const requested = typeof record.workspace === 'string' && record.workspace.trim() ? record.workspace.trim() : ''
  const workspace = requested ? resolveWorkspaceDir(requested, '连接器路径只能查看已登记的工作区。') : null
  return getConnectorPaths(workspace)
})



registerFeatureHandler(CONNECTOR_CHANNELS.trustWorkspace, (payload) => {
  const record = connectorsAsRecord(payload)
  const workspace = connectorsReadString(record, 'workspace', { required: true, max: 4096 }) as string
  return trustWorkspaceConfig(resolveWorkspaceDir(workspace, '只能信任已登记工作区的连接器配置。'))
})



registerFeatureHandler(CONNECTOR_CHANNELS.secretStatus, () => {
  const paths = getConnectorPaths()
  return { mode: paths.secretStorage, secretsPath: paths.secretsPath }
})



registerFeatureHandler(CONNECTOR_CHANNELS.oauthStart, (payload) => {
  const record = connectorsAsRecord(payload)
  const scope = readScope(record)
  const name = connectorsReadString(record, 'name', { required: true, max: 64 }) as string
  return startConnectorOAuth({ scope, name, workspace: readWorkspace(record, scope) })
})



registerFeatureHandler(CONNECTOR_CHANNELS.oauthStatus, (payload) => {
  const record = connectorsAsRecord(payload)
  const scope = readScope(record)
  const name = connectorsReadString(record, 'name', { required: true, max: 64 }) as string
  return connectorOAuthStatus(scope, name, readWorkspace(record, scope))
})



registerFeatureHandler(CONNECTOR_CHANNELS.oauthRevoke, (payload) => {
  const record = connectorsAsRecord(payload)
  const scope = readScope(record)
  const name = connectorsReadString(record, 'name', { required: true, max: 64 }) as string
  return { removed: revokeConnectorOAuth(scope, name, readWorkspace(record, scope)) }
})



let store: EditorHistoryStore | null = null



function history(): EditorHistoryStore {
  if (!store) store = new EditorHistoryStore(dataPath('editor-history'))
  return store
}



function editorAsRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('请求参数格式不对，缺少文件路径')
  }
  return payload as Record<string, unknown>
}



function editorRequireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`缺少参数：${field}`)
  return value
}



function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}



const SOURCES: HistorySource[] = ['user', 'agent', 'baseline', 'restore']



function normalizeSource(value: unknown): HistorySource {
  return typeof value === 'string' && (SOURCES as string[]).includes(value) ? (value as HistorySource) : 'user'
}



/**
 * 版本历史 IPC 的写盘边界：路径必须落在已登记工作区内（解析 symlink 后判断）。
 * record + restore 组合等价于一次文件写入，不能只做「必须先有历史」的弱校验。
 */
function workspaceOnlyPath(rawPath: string): string {
  const target = resolve(rawPath)
  let real = target
  try {
    real = realpathSync(target)
  } catch {
    try {
      real = join(realpathSync(dirname(target)), basename(target))
    } catch {
      throw new Error('文件所在文件夹不存在或不可访问。')
    }
  }
  const roots = knownWorkspaceRoots().map((root) => {
    try {
      return realpathSync(root)
    } catch {
      return resolve(root)
    }
  })
  if (!roots.some((root) => isPathInside(root, real))) {
    throw new Error('版本历史只允许操作工作区内的文件。')
  }
  return target
}



registerFeatureHandler('feature:history:record', async (payload) => {
  const input = editorAsRecord(payload)
  const filePath = workspaceOnlyPath(editorRequireString(input.path, 'path'))
  const content = typeof input.content === 'string' ? input.content : ''
  return history().record({
    path: filePath,
    content,
    source: normalizeSource(input.source),
    mtimeMs: optionalNumber(input.mtimeMs),
    label: typeof input.label === 'string' ? input.label : undefined,
    force: input.force === true
  })
})



registerFeatureHandler('feature:history:list', async (payload) => {
  const input = editorAsRecord(payload)
  return history().list(workspaceOnlyPath(editorRequireString(input.path, 'path')))
})



registerFeatureHandler('feature:history:read', async (payload) => {
  const input = editorAsRecord(payload)
  const filePath = workspaceOnlyPath(editorRequireString(input.path, 'path'))
  const versionId = editorRequireString(input.versionId, 'versionId')
  const result = history().read(filePath, versionId)
  if (!result) throw new Error('找不到这个历史版本，可能已经被清理')
  return result
})



registerFeatureHandler('feature:history:diff', async (payload) => {
  const input = editorAsRecord(payload)
  const filePath = workspaceOnlyPath(editorRequireString(input.path, 'path'))
  const versionId = editorRequireString(input.versionId, 'versionId')
  const targetContent = typeof input.targetContent === 'string' ? input.targetContent : undefined
  const result = history().diff(filePath, versionId, targetContent)
  if (!result) throw new Error('找不到这个历史版本，可能已经被清理')
  return result
})



registerFeatureHandler('feature:history:restore', async (payload) => {
  const input = editorAsRecord(payload)
  const filePath = workspaceOnlyPath(editorRequireString(input.path, 'path'))
  const versionId = editorRequireString(input.versionId, 'versionId')
  return history().restore(filePath, versionId, { expectedMtimeMs: optionalNumber(input.expectedMtimeMs) })
})



registerFeatureHandler('feature:history:clear', async (payload) => {
  const input = editorAsRecord(payload)
  history().clear(workspaceOnlyPath(editorRequireString(input.path, 'path')))
  return { cleared: true }
})



const SNAPSHOT_ROOT = () => dataPath('snapshots')



function payloadOf(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {}
  return payload as Record<string, unknown>
}



function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}



function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}



function globalReadOnly(): boolean {
  try {
    return getSettingsStore().get().permissionMode === 'read-only'
  } catch {
    return false
  }
}



function assertWritable(): void {
  if (globalReadOnly()) {
    throw new WorkspaceFileError(
      'READ_ONLY',
      '当前是只读模式，不能修改文件。',
      '把权限切换为「询问」或「自动」后再试。'
    )
  }
}



/** 收集候选工作区：设置里的最近工作区 + 会话绑定过的工作区（去重、只保留存在的目录）。 */
function candidateWorkspaces(): string[] {
  const list: string[] = []
  try {
    const settings = getSettingsStore().get()
    if (settings.lastWorkspace) list.push(settings.lastWorkspace)
  } catch {
  }
  try {
    const sessions = getSessionStore().list()
    const ordered = sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)
    for (const session of ordered) {
      if (session.workspace) list.push(session.workspace)
    }
  } catch {
  }
  const unique = [...new Set(list.map((item) => resolve(item)))]
  return unique.filter((item) => {
    try {
      return statSync(item).isDirectory()
    } catch {
      return false
    }
  })
}



/**
 * 兼容编辑器只传 { path } 的契约：没有 workspace 时按以下顺序安全回退：
 * 1) 绝对路径 → 找包含它的已绑会话工作区；
 * 2) 相对路径 → 找该文件真实存在的候选工作区；
 * 3) settings.lastWorkspace（若存在）；
 * 4) 只有一个候选工作区时用它；
 * 5) 否则抛错（要求显式传 workspace）。
 */
function resolveWorkspaceFromPayload(payload: Record<string, unknown>): string {
  const explicit = text(payload.workspace).trim()
  if (explicit) {
    try {
      // 显式 workspace 也必须属于已登记工作区，不能拿任意目录当沙箱根
      return resolveWorkspaceDir(explicit, '文件操作只能访问已登记的工作区。')
    } catch (err) {
      throw new WorkspaceFileError(
        'NO_WORKSPACE',
        err instanceof Error ? err.message : '工作区不可用。',
        '请在左下角重新选择工作文件夹，或从当前会话打开文件。'
      )
    }
  }
  const rawPath = text(payload.path || payload.dir || payload.from)
  const candidates = candidateWorkspaces()
  if (!rawPath) {
    const last = candidates[0]
    if (last) return last
    throw new WorkspaceFileError('NO_WORKSPACE', '还没有选择工作文件夹。', '请先在左下角选择工作文件夹。')
  }
  if (isAbsolute(rawPath)) {
    const found = findWorkspaceContaining(rawPath, candidates)
    if (found) return found
    throw new WorkspaceFileError(
      'NO_WORKSPACE',
      '无法确定这个文件所属的工作区。',
      '请在请求里带上 workspace（当前会话的工作区路径）。'
    )
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(join(candidate, rawPath))) return candidate
    } catch {
    }
  }
  const fromSettings = candidates[0]
  if (fromSettings) return fromSettings
  throw new WorkspaceFileError(
    'NO_WORKSPACE',
    '无法确定这个文件所属的工作区。',
    '请在请求里带上 workspace（当前会话的工作区路径）。'
  )
}



function workspaceMeta(): { readOnly: boolean } {
  return { readOnly: globalReadOnly() }
}



/* ── handlers（顶层注册；被 features/index.ts import 即生效） ── */

registerFeatureHandler('feature:files:list', (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  const dir = text(input.dir || input.path) || '.'
  const result = listWorkspaceEntries(workspace, {
    dir,
    showHidden: input.showHidden === true,
    ...(numberOrUndefined(input.limit) !== undefined ? { limit: numberOrUndefined(input.limit) } : {})
  })
  return { ...result, ...workspaceMeta() }
})



registerFeatureHandler('feature:files:read', (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  const result = readWorkspaceFile(workspace, text(input.path), {
    ...(numberOrUndefined(input.maxBytes) !== undefined ? { maxBytes: numberOrUndefined(input.maxBytes) } : {})
  })
  return { ...result, workspace, ...workspaceMeta() }
})



registerFeatureHandler('feature:files:preview', (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  return describeFilePreview(workspace, text(input.path))
})



registerFeatureHandler('feature:files:docx-html', async (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  return convertDocxToHtml(workspace, text(input.path))
})



registerFeatureHandler('feature:files:xlsx-preview', async (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  return convertXlsxToPreview(workspace, text(input.path))
})



registerFeatureHandler('feature:files:pptx-preview', async (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  return convertPptxToPreview(workspace, text(input.path))
})



registerFeatureHandler('feature:files:document-preview', async (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  return convertDocumentToPreview(workspace, text(input.path))
})



registerFeatureHandler('feature:files:archive-list', async (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  return listArchive(workspace, text(input.path))
})



registerFeatureHandler('feature:files:stat', (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  return { ...statWorkspaceFile(workspace, text(input.path)), workspace, ...workspaceMeta() }
})



registerFeatureHandler('feature:files:write', (payload) => {
  const input = payloadOf(payload)
  assertWritable()
  const workspace = resolveWorkspaceFromPayload(input)
  const expected =
    input.expectedMtimeMs === null || input.expectedMtimeMs === undefined
      ? undefined
      : numberOrUndefined(input.expectedMtimeMs)
  if (expected === undefined && input.expectedMtimeMs !== undefined && input.expectedMtimeMs !== null) {
    throw new WorkspaceFileError('INVALID_PATH', 'expectedMtimeMs 必须是数字或 null。')
  }
  const result = writeWorkspaceFile(workspace, text(input.path), text(input.content), {
    snapshotRoot: SNAPSHOT_ROOT(),
    expectedMtimeMs: expected,
    source: text(input.source) || 'files-ui'
  })
  return { ...result, workspace }
})



registerFeatureHandler('feature:files:create', (payload) => {
  const input = payloadOf(payload)
  assertWritable()
  const workspace = resolveWorkspaceFromPayload(input)
  const kind = input.kind === 'dir' ? 'dir' : 'file'
  return { ...createWorkspaceEntry(workspace, text(input.path), kind), workspace }
})



registerFeatureHandler('feature:files:rename', (payload) => {
  const input = payloadOf(payload)
  assertWritable()
  const workspace = resolveWorkspaceFromPayload(input)
  return { ...renameWorkspaceEntry(workspace, text(input.from), text(input.to)), workspace }
})



registerFeatureHandler('feature:files:move', (payload) => {
  const input = payloadOf(payload)
  assertWritable()
  const workspace = resolveWorkspaceFromPayload(input)
  return { ...moveWorkspaceEntry(workspace, text(input.from), text(input.toDir)), workspace }
})



registerFeatureHandler('feature:files:delete', (payload) => {
  const input = payloadOf(payload)
  assertWritable()
  const workspace = resolveWorkspaceFromPayload(input)
  return {
    ...deleteWorkspaceEntry(workspace, text(input.path), {
      recursive: input.recursive === true,
      confirm: input.confirm === true
    }),
    workspace
  }
})



registerFeatureHandler('feature:files:inspect', (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  return { ...inspectWorkspaceEntry(workspace, text(input.path)), workspace }
})



registerFeatureHandler('feature:files:reveal', async (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  const stat = statWorkspaceFile(workspace, text(input.path))
  const error = await revealInFileManager(stat.absolutePath)
  if (error) throw new Error(`打开文件夹失败：${error}`)
  return { ok: true, path: stat.path }
})



/** 原生拖拽：从文件树把文件拖进 Composer/资源管理器（Composer 已有 files/getPathForFile 处理）。 */
registerFeatureHandler('feature:files:startDrag', (payload, event: IpcMainInvokeEvent) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  const stat = statWorkspaceFile(workspace, text(input.path))
  if (stat.kind !== 'file') {
    throw new WorkspaceFileError('NOT_A_FILE', '只能拖拽文件，不能拖拽文件夹。')
  }
  const icon = dragIcon()
  try {
    event.sender.startDrag({ file: stat.absolutePath, icon })
  } catch (err) {
    log.warn('files startDrag failed', { error: String(err) })
    throw new WorkspaceFileError('DRAG_FAILED', '启动拖拽失败，可以改用输入框的「添加文件」。')
  }
  return { ok: true, path: stat.path, absolutePath: stat.absolutePath }
})



let cachedDragIcon: Electron.NativeImage | null = null



function dragIcon(): Electron.NativeImage {
  if (cachedDragIcon) return cachedDragIcon
  const candidates = [join(app.getAppPath(), 'build', 'icon.png'), join(process.resourcesPath ?? '', 'icon.png')]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        const image = nativeImage.createFromPath(candidate)
        if (!image.isEmpty()) {
          cachedDragIcon = image.resize({ width: 32, height: 32 })
          return cachedDragIcon
        }
      }
    } catch {
      // try next
    }
  }
  cachedDragIcon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFUlEQVR42mNkYPj/n4GBgYGJgYGBgQEAJQAB/8p1sQAAAABJRU5ErkJggg=='
  )
  return cachedDragIcon
}



registerFeatureHandler('feature:media:status', async () => {
  return getMediaService().status()
})



registerFeatureHandler('feature:media:start', async () => {
  return getMediaService().startEngine()
})



registerFeatureHandler('feature:media:probe', async (payload) => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const workspace = typeof record.workspace === 'string' ? record.workspace : ''
  const path = typeof record.path === 'string' ? record.path : ''
  if (!workspace || !path) throw new Error('缺少工作区或文件路径。')
  return getMediaService().probeMedia({ workspace, path })
})



registerFeatureHandler('feature:media:pick', async (payload, event) => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const kind = record.kind === 'ffmpeg' ? 'ffmpeg' : 'dir'
  // Windows 的 ffmpeg 是 .exe；macOS/Linux 的可执行文件没有扩展名，不能过滤掉。
  const filters =
    kind === 'dir' ? undefined : process.platform === 'win32' ? [{ name: 'ffmpeg', extensions: ['exe'] }] : undefined
  const options = {
    title: kind === 'dir' ? '选择 ComfyUI 安装目录' : '选择 ffmpeg 可执行文件',
    properties: kind === 'dir' ? ['openDirectory' as const] : ['openFile' as const],
    filters
  }
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : result.filePaths[0] ?? null
})



registerFeatureHandler('feature:media:catalog', async () => {
  return getMediaCatalog().status()
})



registerFeatureHandler('feature:media:catalog-action', async (payload) => {
  const record = payload && typeof payload === 'object' ? (payload as MediaCatalogAction) : null
  if (!record?.action) throw new Error('缺少模型/引擎操作。')
  const catalog = getMediaCatalog()
  const signal = new AbortController().signal
  switch (record.action) {
    case 'install-model':
      if (!record.id) throw new Error('缺少模型 id。')
      return catalog.installModel(record.id, () => undefined, signal)
    case 'uninstall-model':
      if (!record.id) throw new Error('缺少模型 id。')
      return catalog.uninstallModel(record.id)
    case 'start-engine':
      if (!record.id) throw new Error('缺少引擎 id。')
      return catalog.startEngine(record.id, typeof record.modelId === 'string' ? record.modelId : undefined)
    case 'stop-engine':
      if (!record.id) throw new Error('缺少引擎 id。')
      return catalog.stopEngine(record.id)
    case 'install-engine':
      if (!record.id) throw new Error('缺少引擎 id。')
      return catalog.installEngine(record.id)
    case 'register-model':
      if (!record.manifest) throw new Error('缺少模型清单。')
      return catalog.registerModel(record.manifest)
    case 'remove-model':
      if (!record.id) throw new Error('缺少模型 id。')
      return catalog.removeModel(record.id)
    case 'register-engine':
      if (!record.manifest) throw new Error('缺少引擎清单。')
      return catalog.registerEngine(record.manifest)
    case 'remove-engine':
      if (!record.id) throw new Error('缺少引擎 id。')
      return catalog.removeEngine(record.id)
    default:
      throw new Error(`不支持的操作：${String(record.action)}`)
  }
})



registerFeatureHandler('feature:media:open-model-dir', async (payload) => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const engineId = typeof record.engineId === 'string' ? record.engineId : ''
  const catalog = await getMediaCatalog().status()
  const engine = catalog.engines.find((item) => item.id === engineId)
  if (!engine?.modelDir) throw new Error('这个引擎还没有模型目录；请先配置引擎目录。')
  const message = await openPathFromUserShell(engine.modelDir)
  if (message) throw new Error(message)
  return engine.modelDir
})



registerFeatureHandler('feature:media:pick-files', async (payload, event) => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : '选择本机模型文件'
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const options = {
    title,
    properties: ['openFile' as const, 'multiSelections' as const]
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
})



registerFeatureHandler('feature:media:resolve-model-files', async (payload) => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const engineId = typeof record.engineId === 'string' ? record.engineId : ''
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  if (!engineId) throw new Error('请选择模型所属引擎。')
  if (paths.length === 0) throw new Error('请选择至少一个模型文件。')
  const catalog = await getMediaCatalog().status()
  const engine = catalog.engines.find((item) => item.id === engineId)
  if (!engine) throw new Error(`引擎不存在：${engineId}`)
  const modelDir = engine.modelDir
  if (!modelDir) throw new Error(`引擎「${engine.label}」还没有模型目录；请先在上方配置引擎目录。`)

  const uniqueTarget = (name: string): string => {
    const target = join(modelDir, name)
    if (!existsSync(target)) return target
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length)
    for (let index = 2; index < 1000; index += 1) {
      const candidate = join(modelDir, `${stem}-${index}${ext}`)
      if (!existsSync(candidate)) return candidate
    }
    throw new Error(`模型目录里同名文件过多：${name}`)
  }

  const results: Array<{ path: string; dest: string; size: number; copied: boolean }> = []
  for (const raw of paths) {
    const source = resolve(raw.trim())
    if (!existsSync(source)) throw new Error(`模型文件不存在：${source}`)
    const stat = statSync(source)
    if (!stat.isFile()) throw new Error(`不是文件：${source}`)
    const rel = relative(modelDir, source)
    const inside = !rel.startsWith('..') && !isAbsolute(rel)
    if (inside) {
      results.push({ path: source, dest: rel.replace(/\\/g, '/'), size: stat.size, copied: false })
      continue
    }
    // 下载目录里的模型不应逼用户手动搬运：复制进引擎模型目录，重名时自动加序号。
    const target = uniqueTarget(basename(source))
    try {
      await copyFile(source, target)
    } catch (err) {
      throw new Error(`复制模型文件失败：${err instanceof Error ? err.message : String(err)}`)
    }
    results.push({
      path: target,
      dest: relative(modelDir, target).replace(/\\/g, '/'),
      size: stat.size,
      copied: true
    })
  }
  return results
})



registerFeatureHandler('feature:media:pick-manifest', async (payload, event) => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const kind = record.kind === 'engine' ? 'engine' : 'model'
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const options = {
    title: kind === 'engine' ? '导入引擎清单（JSON）' : '导入模型清单（JSON）',
    properties: ['openFile' as const],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null
  const { readFileSync } = await import('node:fs')
  try {
    return { kind, manifest: JSON.parse(readFileSync(result.filePaths[0], 'utf8')) as Record<string, unknown> }
  } catch (err) {
    throw new Error(`清单不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
})



/** 注册函数签名（与 feature-ipc 的 registerFeatureHandler 兼容；模块不直接依赖 feature-ipc） */
export type MemoryRegisterChannel = (
  channel: string,
  handler: (payload: unknown, event?: unknown) => unknown | Promise<unknown>
) => void



/** 本模块注册的全部频道，便于集成/测试断言 */
export const MEMORY_FEATURE_CHANNELS = [
  'feature:memory:list',
  'feature:memory:add',
  'feature:memory:update',
  'feature:memory:toggle',
  'feature:memory:remove',
  'feature:memory:clear',
  'feature:memory:export',
  'feature:memory:injection',
  'feature:memory:episodes',
  'feature:memory:episodeToggle',
  'feature:memory:episodeRemove',
  'feature:memory:episodeClear',
  'feature:memory:episodeInjection'
] as const



export interface MemoryFeatureOptions {
  /** 显式数据目录（测试用）；不传时在 app ready 后解析真实 userData */
  dataDir?: string
  /** 测试用：覆盖已登记工作区校验；生产环境始终走 resolveWorkspaceDir */
  isWorkspaceAllowed?: (workspace: string) => boolean
}



function record(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('参数格式不正确')
  return payload as Record<string, unknown>
}



function parseScope(payload: Record<string, unknown>): MemoryScope {
  const scope = payload.scope
  if (scope !== 'project' && scope !== 'global') throw new Error('scope 必须是 project 或 global')
  return scope
}



function workspaceOf(payload: Record<string, unknown>): string | null {
  const workspace = payload.workspace
  if (workspace === undefined || workspace === null || workspace === '') return null
  if (typeof workspace !== 'string') throw new Error('workspace 必须是字符串')
  return workspace
}



function memoryRequireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string') throw new Error(`缺少 ${key}`)
  return value
}



/** 记忆 IPC 的工作区边界：只接受已登记的、真实存在的工作区目录。 */
function resolveProjectWorkspace(data: Record<string, unknown>, options: MemoryFeatureOptions): string {
  const raw = workspaceOf(data)
  if (!raw) throw new Error('项目记忆需要指定工作区')
  if (options.isWorkspaceAllowed) {
    if (!options.isWorkspaceAllowed(raw)) throw new Error('记忆只能读写已登记的工作区。')
    return raw
  }
  return resolveWorkspaceDir(raw, '记忆只能读写已登记的工作区。')
}



function targetWorkspace(
  data: Record<string, unknown>,
  scope: MemoryScope,
  options: MemoryFeatureOptions
): string | null {
  return scope === 'global' ? null : resolveProjectWorkspace(data, options)
}



function stringTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('tags 必须是字符串数组')
  return value.filter((item): item is string => typeof item === 'string')
}



/**
 * 注册记忆中心频道。
 * @param register feature-ipc 的 registerFeatureHandler（由 Lead 传入，避免模块直接 import 形成循环）
 */
export function registerMemoryFeature(register: MemoryRegisterChannel, options: MemoryFeatureOptions = {}): void {
  const dataDir = options.dataDir ?? resolveDataDir()
  const service = (): MemoryService => new MemoryService({ dataDir })
  // 让 Lead 在 agent-service 注入处可直接调用 getMemoryPrompt(workspace)（不传 dataDir）
  configureMemoryRuntime(dataDir)
  log.info('memory feature registered', { dataDir })

  register('feature:memory:list', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    const query = typeof data.query === 'string' ? data.query : undefined
    return service().list(scope, workspace, { query, includeDisabled: data.includeDisabled === true })
  })

  register('feature:memory:add', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    const entry = service().add({
      scope,
      workspace,
      text: memoryRequireString(data, 'text'),
      tags: stringTags(data.tags),
      enabled: data.enabled !== false,
      source: 'user'
    })
    log.info('memory added', { scope: entry.scope, id: entry.id })
    sendFeatureEvent(MEMORY_CHANGED_EVENT, { scope, workspace })
    return { entry }
  })

  register('feature:memory:update', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const patch: { text?: string; tags?: string[]; enabled?: boolean } = {}
    if (data.text !== undefined) patch.text = memoryRequireString(data, 'text')
    const tags = stringTags(data.tags)
    if (tags !== undefined) patch.tags = tags
    if (data.enabled !== undefined) patch.enabled = data.enabled === true
    const workspace = targetWorkspace(data, scope, options)
    const entry = service().update(scope, workspace, memoryRequireString(data, 'id'), patch)
    sendFeatureEvent(MEMORY_CHANGED_EVENT, { scope, workspace })
    return { entry }
  })

  register('feature:memory:toggle', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const id = memoryRequireString(data, 'id')
    const enabled = typeof data.enabled === 'boolean' ? data.enabled : undefined
    const workspace = targetWorkspace(data, scope, options)
    const entry = service().toggle(scope, workspace, id, enabled)
    sendFeatureEvent(MEMORY_CHANGED_EVENT, { scope, workspace })
    return { entry }
  })

  register('feature:memory:remove', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    service().remove(scope, workspace, memoryRequireString(data, 'id'))
    sendFeatureEvent(MEMORY_CHANGED_EVENT, { scope, workspace })
    return { removed: true }
  })

  register('feature:memory:clear', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    const result = service().clear(scope, workspace)
    log.info('memory cleared', { scope, removed: result.removed })
    sendFeatureEvent(MEMORY_CHANGED_EVENT, { scope, workspace })
    return result
  })

  register('feature:memory:export', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    return service().exportMemory(scope, targetWorkspace(data, scope, options))
  })

  /** 注入预览：UI 展示「哪些记忆会被送进系统提示 / 用多少 token」，也是验收证据 */
  register('feature:memory:injection', (payload) => {
    const data = record(payload)
    const rawWorkspace = workspaceOf(data)
    let workspace: string | null = null
    if (rawWorkspace) {
      if (options.isWorkspaceAllowed) {
        if (!options.isWorkspaceAllowed(rawWorkspace)) throw new Error('记忆只能读写已登记的工作区。')
        workspace = rawWorkspace
      } else {
        workspace = resolveWorkspaceDir(rawWorkspace, '记忆只能读写已登记的工作区。')
      }
    }
    return getMemoryInjection(workspace, {
      dataDir,
      maxTokens: typeof data.maxTokens === 'number' ? data.maxTokens : undefined
    })
  })

  register('feature:memory:episodes', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    const query = typeof data.query === 'string' ? data.query : undefined
    return service().listEpisodes(scope, workspace, {
      query,
      includeDisabled: data.includeDisabled === true
    })
  })

  register('feature:memory:episodeToggle', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    const enabled = typeof data.enabled === 'boolean' ? data.enabled : undefined
    const entry = service().toggleEpisode(scope, workspace, memoryRequireString(data, 'id'), enabled)
    sendFeatureEvent(EPISODE_CHANGED_EVENT, { scope, workspace })
    return { entry }
  })

  register('feature:memory:episodeRemove', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    service().removeEpisode(scope, workspace, memoryRequireString(data, 'id'))
    sendFeatureEvent(EPISODE_CHANGED_EVENT, { scope, workspace })
    return { removed: true }
  })

  register('feature:memory:episodeClear', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    const result = service().clearEpisodes(scope, workspace)
    log.info('task episodes cleared', { scope, removed: result.removed })
    sendFeatureEvent(EPISODE_CHANGED_EVENT, { scope, workspace })
    return result
  })

  register('feature:memory:episodeInjection', (payload) => {
    const data = record(payload)
    const rawWorkspace = workspaceOf(data)
    let workspace: string | null = null
    if (rawWorkspace) {
      if (options.isWorkspaceAllowed) {
        if (!options.isWorkspaceAllowed(rawWorkspace)) throw new Error('记忆只能读写已登记的工作区。')
        workspace = rawWorkspace
      } else {
        workspace = resolveWorkspaceDir(rawWorkspace, '记忆只能读写已登记的工作区。')
      }
    }
    return service().episodeInjection(
      workspace,
      typeof data.query === 'string' ? data.query : '',
      { maxTokens: typeof data.maxTokens === 'number' ? data.maxTokens : undefined }
    )
  })
}



function suggestionId(data: Record<string, unknown>): string {
  const id = memoryRequireString(data, 'id').trim()
  if (!id) throw new Error('缺少建议 id')
  return id
}



/** 注册自进化建议频道；复盘写回记忆/技能库，仍以用户采纳为前提。 */
export function registerEvolutionFeature(
  register: MemoryRegisterChannel,
  options: { dataDir?: string } = {}
): void {
  const dataDir = options.dataDir ?? resolveDataDir()
  configureEvolutionRuntime(dataDir)
  log.info('evolution feature registered', { dataDir })

  const service = () => {
    const instance = getEvolutionService()
    if (!instance) throw new Error('建议服务尚未初始化')
    return instance
  }

  register('feature:evolution:list', (payload) => {
    const data = payload === undefined || payload === null ? {} : record(payload)
    const workspace = typeof data.workspace === 'string' && data.workspace.trim() ? data.workspace.trim() : null
    return service().list(workspace)
  })

  register('feature:evolution:review', async (payload) => {
    const data = record(payload)
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : ''
    if (!sessionId) throw new Error('缺少 sessionId')
    return getAgentService(getSettingsStore(), getSessionStore()).reviewEvolution(sessionId, true)
  })

  register('feature:evolution:apply', (payload) => {
    const result = service().apply(suggestionId(record(payload)))
    const pending = service().pendingCount()
    sendFeatureEvent(EVOLUTION_CHANGED_EVENT, { reason: 'applied', pending })
    return result
  })

  register('feature:evolution:ignore', (payload) => {
    service().ignore(suggestionId(record(payload)))
    const pending = service().pendingCount()
    sendFeatureEvent(EVOLUTION_CHANGED_EVENT, { reason: 'ignored', pending })
    return { ignored: true, pending }
  })
}



/** 注册函数签名（与 feature-ipc 的 registerFeatureHandler 兼容；模块不直接依赖 feature-ipc） */
export type ProjectsRegisterChannel = (
  channel: string,
  handler: (payload: unknown, event?: unknown) => unknown | Promise<unknown>
) => void



/** 本模块注册的全部频道，便于集成/测试断言 */
export const PROJECTS_FEATURE_CHANNELS = [
  'feature:projects:list',
  'feature:projects:get',
  'feature:projects:create',
  'feature:projects:update',
  'feature:projects:remove',
  'feature:projects:set-active',
  'feature:projects:set-pinned',
  'feature:projects:knowledge-validate',
  'feature:projects:knowledge-pick',
  'feature:projects:context'
] as const



export interface ProjectsFeatureOptions {
  /** 显式数据目录（测试用）；不传时在 app ready 后解析真实 userData */
  dataDir?: string
}



function projectsRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('参数格式不正确')
  return payload as Record<string, unknown>
}



function projectsRequireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少 ${key}`)
  return value
}



function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`)
  return value
}



function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`)
  return value
}



function optionalWorkspace(payload: Record<string, unknown>): string | undefined {
  const value = payload.workspace
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error('workspace 必须是非空字符串')
  return normalizeProjectWorkspace(value)
}



function optionalKnowledgePaths(payload: Record<string, unknown>): string[] | undefined {
  const value = payload.knowledgePaths
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('knowledgePaths 必须是字符串数组')
  }
  return value as string[]
}



function projectPatchOf(data: Record<string, unknown>): ProjectUpdateInput {
  const knowledgePaths = optionalKnowledgePaths(data)
  const name = optionalString(data, 'name')
  const description = optionalString(data, 'description')
  const instructions = optionalString(data, 'instructions')
  const pinned = optionalBoolean(data, 'pinned')
  const active = optionalBoolean(data, 'active')
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(knowledgePaths !== undefined ? { knowledgePaths } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
    ...(active !== undefined ? { active } : {})
  }
}



function contextOptions(payload: Record<string, unknown>, dataDir: string): ProjectContextOptions {
  return {
    dataDir,
    ...(typeof payload.maxTokens === 'number' ? { maxTokens: payload.maxTokens } : {}),
    ...(typeof payload.memoryTokens === 'number' ? { memoryTokens: payload.memoryTokens } : {}),
    ...(payload.ignoreActive === true ? { ignoreActive: true } : {})
  }
}



/**
 * 注册 Projects 频道。
 * @param register feature-ipc 的 registerFeatureHandler（由 Lead 传入，避免模块直接 import 形成循环）
 */
export function registerProjectsFeature(register: ProjectsRegisterChannel, options: ProjectsFeatureOptions = {}): void {
  const dataDir = options.dataDir ?? resolveDataDir()
  const service = (): ProjectService => new ProjectService({ dataDir })
  // 让 Lead 在 agent-service 注入处可直接调用 getProjectContext(workspace) / getProjectPrompt(workspace)
  configureProjectsRuntime(dataDir)
  log.info('projects feature registered', { dataDir })

  register('feature:projects:list', () => ({ projects: service().list() }))

  register('feature:projects:get', (payload) => {
    const data = projectsRecord(payload)
    if (typeof data.id === 'string' && data.id) return service().getById(data.id)
    const workspace = optionalWorkspace(data)
    if (workspace) return service().getByWorkspace(workspace)
    throw new Error('需要 id 或 workspace')
  })

  register('feature:projects:create', (payload) => {
    const data = projectsRecord(payload)
    const knowledgePaths = optionalKnowledgePaths(data)
    const pinned = optionalBoolean(data, 'pinned')
    const active = optionalBoolean(data, 'active')
    const input: ProjectCreateInput = {
      workspace: projectsRequireString(data, 'workspace'),
      name: optionalString(data, 'name') ?? '',
      description: optionalString(data, 'description') ?? '',
      instructions: optionalString(data, 'instructions') ?? '',
      ...(knowledgePaths !== undefined ? { knowledgePaths } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(active !== undefined ? { active } : {})
    }
    const project = service().create(input)
    log.info('project created', { id: project.id, workspace: project.workspace })
    return project
  })

  register('feature:projects:update', (payload) => {
    const data = projectsRecord(payload)
    return service().update(projectsRequireString(data, 'id'), projectPatchOf(data))
  })

  register('feature:projects:remove', (payload) => {
    service().remove(projectsRequireString(projectsRecord(payload), 'id'))
    return { removed: true }
  })

  register('feature:projects:set-active', (payload) => {
    const data = projectsRecord(payload)
    return service().setActive(projectsRequireString(data, 'id'), optionalBoolean(data, 'active') !== false)
  })

  register('feature:projects:set-pinned', (payload) => {
    const data = projectsRecord(payload)
    return service().setPinned(projectsRequireString(data, 'id'), optionalBoolean(data, 'pinned') === true)
  })

  /** 校验单个知识文件（UI 手动输入相对路径时用） */
  register('feature:projects:knowledge-validate', (payload) => {
    const data = projectsRecord(payload)
    return service().validateKnowledgePath(projectsRequireString(data, 'workspace'), projectsRequireString(data, 'path'))
  })

  /** 系统文件选择器 + 校验（UI「选择知识文件」按钮用）；逐个返回校验结果 */
  register('feature:projects:knowledge-pick', async (payload) => {
    const data = projectsRecord(payload)
    const workspace = normalizeProjectWorkspace(projectsRequireString(data, 'workspace'))
    const picked = await dialog.showOpenDialog({
      title: '选择项目知识文件',
      buttonLabel: '加入项目知识',
      defaultPath: workspace,
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { files: [] as ProjectKnowledgeInfo[], errors: [] as Array<{ path: string; error: string }> }
    }
    const files: ProjectKnowledgeInfo[] = []
    const errors: Array<{ path: string; error: string }> = []
    for (const file of picked.filePaths.slice(0, 50)) {
      try {
        files.push(service().validateKnowledgePath(workspace, file))
      } catch (err) {
        errors.push({ path: file, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { files, errors }
  })

  /** 生成项目上下文预览（含记忆中心），UI 展示「会注入什么」；ignoreActive=true 用于编辑预览 */
  register('feature:projects:context', (payload) => {
    const data = projectsRecord(payload)
    const workspace = normalizeProjectWorkspace(projectsRequireString(data, 'workspace'))
    return getProjectContext(workspace, contextOptions(data, dataDir))
  })
}



interface QueryPayload {
  q?: unknown
  workspace?: unknown
  limit?: unknown
}



interface RefreshPayload {
  workspace?: unknown
  sessionId?: unknown
  full?: unknown
}



const MAX_QUERY_CHARS = 200


/** 全局搜索不再受侧栏 300 条上限影响；仍设一个上限避免启动索引无限膨胀 */
const MAX_SEARCH_SESSIONS = 1000



function knownWorkspaces(meta: SessionMeta[]): string[] {
  const workspaces = new Set<string>()
  try {
    const settings = getSettingsStore().get()
    if (settings.lastWorkspace && existsSync(settings.lastWorkspace)) workspaces.add(settings.lastWorkspace)
    for (const workspace of settings.recentWorkspaces) {
      if (workspace && existsSync(workspace)) workspaces.add(workspace)
    }
  } catch {
    // 设置不可用时只依赖会话工作区
  }
  for (const session of meta) {
    if (session.workspace && existsSync(session.workspace)) workspaces.add(session.workspace)
  }
  return [...workspaces]
}



function searchSessionMetas(store: ReturnType<typeof getSessionStore>): SessionMeta[] {
  try {
    const all = store.listAll()
    return all.length > MAX_SEARCH_SESSIONS ? all.slice(0, MAX_SEARCH_SESSIONS) : all
  } catch (err) {
    log.warn('search: listSessions failed', String(err))
    return []
  }
}



function createService(): WorkspaceSearchService {
  ensureDataDirs()
  const sessionStore = getSessionStore()
  return new WorkspaceSearchService({
    listSessions: () => searchSessionMetas(sessionStore),
    getSession: (id): Session | null => {
      try {
        return sessionStore.get(id)
      } catch {
        return null
      }
    },
    getSessionRevision: () => sessionStore.getRevision(),
    listWorkspaces: () => knownWorkspaces(searchSessionMetas(sessionStore)),
    dataDir: dataPath(),
    now: Date.now
  })
}



let service: WorkspaceSearchService | null = null


let started: Promise<void> | null = null



function getService(): WorkspaceSearchService {
  if (!service) service = createService()
  return service
}



function ensureStarted(): Promise<void> {
  if (!started) {
    started = getService().start().catch((err) => {
      log.warn('search: initial index failed', String(err))
      started = null
    })
  }
  return started
}



/** 由 Lead 在 app ready 后调用；避免 feature import 时提前初始化 settings/搜索结果 */
export function warmSearchIndex(): void {
  void ensureStarted()
}



function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}



/**
 * 搜索请求里的 workspace 必须是已登记工作区；否则索引器会扫描任意目录。
 * 返回原始路径（索引键与会话 workspace 保持同一形式，链接别名交给 realpath 校验）。
 */
function validateSearchWorkspace(raw: string): string {
  resolveWorkspaceDir(raw, '搜索只能访问已登记的工作区。')
  return raw
}



setSearchInvalidationHandler(async (sessionId) => {
  // 搜索从未打开过（service 未创建）时没有需要清理的索引
  if (!service) return
  await ensureStarted()
  await service.refreshSession(sessionId)
})



setSearchClearHandler(async () => {
  if (!service) return
  await service.rebuild()
})



registerFeatureHandler('feature:search:query', async (payload) => {
  const input = (payload ?? {}) as QueryPayload
  const q = asString(input.q) ?? ''
  if (q.length > MAX_QUERY_CHARS) {
    throw new Error(`搜索词过长（最多 ${MAX_QUERY_CHARS} 字符）。`)
  }
  // 不传 workspace = 全局搜索；显式传字符串才限定文件夹
  const rawWorkspace = asString(input.workspace)
  const workspace = rawWorkspace ? validateSearchWorkspace(rawWorkspace) : null
  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.trunc(input.limit) : 20
  await ensureStarted()
  const query: SearchQueryInput = { q, workspace, limit }
  return getService().search(query)
})



registerFeatureHandler('feature:search:status', async () => {
  await ensureStarted()
  return getService().status()
})



registerFeatureHandler('feature:search:refresh', async (payload) => {
  const input = (payload ?? {}) as RefreshPayload
  const rawWorkspace = asString(input.workspace)
  const workspace = rawWorkspace ? validateSearchWorkspace(rawWorkspace) : null
  const sessionId = asString(input.sessionId)
  await ensureStarted()
  if (input.full === true) {
    await getService().rebuild()
  } else {
    if (sessionId) await getService().refreshSession(sessionId)
    if (workspace) await getService().refreshWorkspace(workspace)
    if (!sessionId && !workspace) await getService().start()
  }
  return getService().status()
})



// Lead 在保存会话/工具完成后可精确通知（也可完全依赖查询前自动刷新）
registerFeatureHandler('feature:search:session-updated', async (payload) => {
  const input = (payload ?? {}) as RefreshPayload
  const sessionId = asString(input.sessionId)
  if (!sessionId) throw new Error('缺少 sessionId。')
  await ensureStarted()
  const indexed = await getService().refreshSession(sessionId)
  return { indexed }
})



registerFeatureHandler('feature:search:workspace-updated', async (payload) => {
  const input = (payload ?? {}) as RefreshPayload
  const rawWorkspace = asString(input.workspace)
  if (!rawWorkspace) throw new Error('缺少 workspace 路径。')
  const workspace = validateSearchWorkspace(rawWorkspace)
  await ensureStarted()
  await getService().refreshWorkspace(workspace)
  return getService().status()
})



export const SIDECHAT_EVENT = 'feature:sidechat:event'



const controllers = new Map<string, AbortController>()



/** 清除全部对话时中止所有侧聊，避免它们在数据清空后继续写用量。 */
export function abortAllSideChats(): void {
  for (const controller of controllers.values()) controller.abort()
  controllers.clear()
  sessionRequests.clear()
}


const sessionRequests = new Map<string, string>()


const MAX_CONCURRENT = 8


const MAX_HISTORY_CHARS = 12_000



function sidechatPayloadOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}



function sidechatText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}



registerFeatureHandler('feature:sidechat:ask', (payload) => {
  const input = sidechatPayloadOf(payload)
  const sessionId = sidechatText(input.sessionId, 128)
  const question = sidechatText(input.question, 8000)
  if (!sessionId) throw new Error('缺少会话 id。')
  if (!question) throw new Error('问题不能为空。')
  const parsedHistory: SideChatHistoryItem[] = Array.isArray(input.history)
    ? input.history
        .slice(-12)
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const record = item as Record<string, unknown>
          const content = sidechatText(record.content, 8000)
          if (!content) return null
          return { role: record.role === 'assistant' ? ('assistant' as const) : ('user' as const), content }
        })
        .filter((item): item is SideChatHistoryItem => item !== null)
    : []
  // 从最新消息往旧消息分配总额度，避免 12×8KB 历史超小上下文
  const history: SideChatHistoryItem[] = []
  let historyChars = 0
  for (const item of [...parsedHistory].reverse()) {
    if (historyChars >= MAX_HISTORY_CHARS) break
    const remaining = MAX_HISTORY_CHARS - historyChars
    const content = item.content.slice(0, remaining)
    if (!content) continue
    history.unshift({ role: item.role, content })
    historyChars += content.length
  }

  // requestId 由渲染层生成并在 invoke 前保存，避免极快模型的事件先于 IPC 返回值到达而被丢弃
  const requestedId = sidechatText(input.requestId, 80)
  const requestId = /^[A-Za-z0-9_-]{8,80}$/.test(requestedId)
    ? requestedId
    : `side_${randomUUID().slice(0, 12)}`
  if (controllers.size >= MAX_CONCURRENT && !controllers.has(requestId)) {
    throw new Error('同时进行的侧边聊天过多，请稍后再试。')
  }
  const previous = sessionRequests.get(sessionId)
  if (previous && previous !== requestId) controllers.get(previous)?.abort()
  const controller = new AbortController()
  controllers.set(requestId, controller)
  sessionRequests.set(sessionId, requestId)
  void (async () => {
    try {
      const result = await runSideChat(
        {
          sessionId,
          question,
          useContext: input.useContext !== false,
          history
        },
        (delta) => sendFeatureEvent(SIDECHAT_EVENT, { requestId, type: 'delta', text: delta }),
        controller.signal,
        (message) => sendFeatureEvent(SIDECHAT_EVENT, { requestId, type: 'notice', message })
      )
      if (!getSessionStore().get(sessionId)?.temporary) {
        recordTokenUsage({
          sessionId,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens ?? 0,
          estimatedInputTokens:
            result.usage.inputTokens > 0
              ? 0
              : estimateTokens(question) + history.reduce((sum, item) => sum + estimateTokens(item.content), 0),
          estimatedOutputTokens: result.usage.outputTokens > 0 ? 0 : estimateTokens(result.text)
        })
      }
      sendFeatureEvent(SIDECHAT_EVENT, {
        requestId,
        type: 'done',
        text: result.text,
        usage: result.usage
      })
    } catch (err) {
      const aborted = controller.signal.aborted
      sendFeatureEvent(SIDECHAT_EVENT, {
        requestId,
        type: aborted ? 'cancelled' : 'error',
        ...(aborted ? {} : { error: err instanceof Error ? err.message : String(err) })
      })
    } finally {
      controllers.delete(requestId)
      if (sessionRequests.get(sessionId) === requestId) sessionRequests.delete(sessionId)
    }
  })()
  return { requestId }
})



registerFeatureHandler('feature:sidechat:cancel', (payload) => {
  const requestId = sidechatText(sidechatPayloadOf(payload).requestId, 128)
  const controller = controllers.get(requestId)
  if (!controller) return { cancelled: false }
  controller.abort()
  for (const [sessionId, activeId] of sessionRequests) {
    if (activeId === requestId) sessionRequests.delete(sessionId)
  }
  return { cancelled: true }
})



/** 注册函数签名（与 feature-ipc 的 registerFeatureHandler 一致；模块不直接依赖 feature-ipc） */
export type SkillsRegisterChannel = (channel: string, handler: (payload: unknown) => Promise<unknown>) => void



const effects: SkillsFeatureEffects = {
  async revealPath(path: string): Promise<void> {
    const error = await openPathFromUserShell(path)
    if (error) throw new Error(`打开技能目录失败：${error}`)
  },
  async openUserDir(path: string): Promise<void> {
    const error = await openPathFromUserShell(path)
    if (error) throw new Error(`打开技能库目录失败：${error}`)
  },
  async pickZip(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: '选择技能包（.zip）',
      buttonLabel: '安装技能包',
      properties: ['openFile'],
      filters: [{ name: '技能包', extensions: ['zip'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  },
  async pickFolder(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: '选择技能文件夹（必须包含 SKILL.md）',
      buttonLabel: '选择文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  }
}



/**
 * 注册技能库 feature 频道（必须在 app ready 之后、主进程 IPC 挂载之前调用）。
 * 同时把用户技能库路径/状态文件注入 core 环境变量。
 */
export function registerSkillsFeature(register: SkillsRegisterChannel): void {
  const dataDir = resolveDataDir()
  ensureBuiltinSkills(dataDir)
  const service = createSkillsService({ dataDir })
  installSkillsRuntimeEnv(service)
  for (const [channel, handler] of Object.entries(createSkillsFeatureHandlers(service, effects))) {
    register(channel, handler)
  }
}



function recordOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
}



registerFeatureHandler('feature:studio:action', async (payload) => {
  const request = recordOf(payload)
  const type = typeof request.type === 'string' ? request.type : ''
  if (!type) throw new Error('缺少创作台操作类型。')
  return getStudioService().execute(request as { type: string; projectId?: string; [key: string]: unknown })
})



registerFeatureHandler('feature:studio:pick-import', async (payload, event) => {
  const input = recordOf(payload)
  const title = typeof input.title === 'string' ? input.title : '导入素材'
  const kind = input.kind === 'video' ? 'video' : input.kind === 'audio' ? 'audio' : 'image'
  const filters =
    kind === 'video'
      ? [{ name: '视频', extensions: ['mp4', 'webm', 'mov', 'mkv'] }]
      : kind === 'audio'
        ? [{ name: '音频', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg'] }]
        : [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const options = {
    title,
    properties: ['openFile' as const, ...(input.multiple === true ? ['multiSelections' as const] : [])],
    filters
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
})



registerFeatureHandler('feature:studio:pick-package', async (_payload, event) => {
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const options = {
    title: '导入创作台工程包',
    properties: ['openFile' as const],
    filters: [{ name: 'Morrow 创作台工程包', extensions: ['morrowcraft', 'zip'] }]
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
})



registerFeatureHandler('feature:studio:reveal', async (payload) => {
  const input = recordOf(payload)
  const projectId = typeof input.projectId === 'string' ? input.projectId : ''
  const path = typeof input.path === 'string' ? input.path : ''
  if (!projectId || !path) throw new Error('缺少作品或文件路径。')
  const absolute = getStudioStore().deliveryAbsolute(projectId, { path })
  const message = await revealInFileManager(absolute)
  if (message) throw new Error(message)
  return true
})



registerFeatureHandler('feature:studio:open-path', async (payload) => {
  const input = recordOf(payload)
  const projectId = typeof input.projectId === 'string' ? input.projectId : ''
  const path = typeof input.path === 'string' ? input.path : ''
  if (!projectId || !path) throw new Error('缺少作品或文件路径。')
  const absolute = getStudioStore().deliveryAbsolute(projectId, { path })
  const message = await openPathFromUserShell(absolute)
  if (message) throw new Error(message)
  return true
})



registerFeatureHandler('feature:studio:open-data-dir', async () => {
  const message = await openPathFromUserShell(getStudioStore().root)
  if (message) throw new Error(message)
  return true
})



registerFeatureHandler('feature:studio:open-project-dir', async (payload) => {
  const input = recordOf(payload)
  const projectId = typeof input.projectId === 'string' ? input.projectId : ''
  if (!projectId) throw new Error('缺少作品。')
  const message = await openPathFromUserShell(getStudioStore().projectDir(projectId))
  if (message) throw new Error(message)
  return true
})



function mainStudioWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().includes('#island'))
}



function studioJobsRunning(): boolean {
  const store = getStudioStore()
  return store.summaries().some((summary) => {
    try {
      return store.readProject(summary.id).jobs.some((job) => job.status === 'running' || job.status === 'queued')
    } catch {
      return false
    }
  })
}



function studioDataTestMode(): boolean {
  return process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')
}



function relaunchStudioSoon(): void {
  if (studioDataTestMode()) {
    resetStudioStoreForTest()
    return
  }
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 800)
}



registerFeatureHandler('feature:studio:data-dir-info', async () => studioDataDirInfo())



registerFeatureHandler('feature:studio:change-data-dir', async () => {
  if (studioJobsRunning()) throw new Error('还有创作台任务在运行，请等待完成或暂停队列后再更换目录。')
  const win = BrowserWindow.getFocusedWindow() ?? mainStudioWindow()
  const picked = win
    ? await dialog.showOpenDialog(win, { title: '选择创作台数据目录', buttonLabel: '选择此文件夹', properties: ['openDirectory', 'createDirectory'] })
    : await dialog.showOpenDialog({ title: '选择创作台数据目录', buttonLabel: '选择此文件夹', properties: ['openDirectory', 'createDirectory'] })
  if (picked.canceled || !picked.filePaths[0]) return { restarted: false, canceled: true }
  const target = resolve(picked.filePaths[0])
  const current = getStudioStore().root
  if (samePath(target, current)) throw new Error('新目录与当前创作台目录相同。')
  if (isNestedPath(target, current) || isNestedPath(current, target)) throw new Error('新目录不能与当前创作台目录互相包含。')
  if (existsSync(target) && !statSync(target).isDirectory()) throw new Error('请选择一个文件夹。')
  try {
    mkdirSync(target, { recursive: true })
  } catch (err) {
    throw new Error(`无法使用该文件夹：${err instanceof Error ? err.message : String(err)}`)
  }
  if (readdirSync(target).length > 0) throw new Error('请选择一个空文件夹，避免覆盖已有内容。')

  const choice = win
    ? await dialog.showMessageBox(win, {
        type: 'question',
        title: '更换创作台数据目录',
        message: '更换后需要重启 Morrow',
        detail: `新目录：${target}

迁移并重启：复制现有创作台作品、素材、历史版本与任务记录；Agent 对话和设置不移动。
仅切换并重启：新目录从空白创作台开始，原目录保留。`,
        buttons: ['迁移并重启', '仅切换并重启', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
    : await dialog.showMessageBox({
        type: 'question',
        title: '更换创作台数据目录',
        message: '更换后需要重启 Morrow',
        detail: `新目录：${target}

迁移并重启：复制现有创作台作品、素材、历史版本与任务记录；Agent 对话和设置不移动。`,
        buttons: ['迁移并重启', '仅切换并重启', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
  if (choice.response === 2) return { restarted: false, canceled: true }
  let files = 0
  if (choice.response === 0) {
    try {
      files = copyUserDataForMigration(current, target)
    } catch (err) {
      try { cleanTargetDataDir(target) } catch { /* 清理失败不掩盖迁移错误 */ }
      throw new Error(`迁移创作台数据失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try {
    writeStudioLocation(target)
  } catch (err) {
    if (choice.response === 0) {
      try { cleanTargetDataDir(target) } catch { /* ignore */ }
    }
    throw new Error(`保存创作台目录失败：${err instanceof Error ? err.message : String(err)}`)
  }
  relaunchStudioSoon()
  return { restarted: !studioDataTestMode(), path: target, files }
})



registerFeatureHandler('feature:studio:reset-data-dir', async () => {
  if (studioJobsRunning()) throw new Error('还有创作台任务在运行，请等待完成或暂停队列后再恢复目录。')
  if (!readStudioLocation()) return { restarted: false, canceled: true }
  const win = BrowserWindow.getFocusedWindow() ?? mainStudioWindow()
  const current = getStudioStore().root
  const defaultRoot = resolveDefaultStudioRoot()
  if (samePath(current, defaultRoot)) {
    removeStudioLocation()
    relaunchStudioSoon()
    return { restarted: !studioDataTestMode(), path: defaultRoot, files: 0 }
  }
  if (isNestedPath(defaultRoot, current) || isNestedPath(current, defaultRoot)) {
    throw new Error('默认目录与当前自定义目录互相包含，无法安全迁回。')
  }
  if (existsSync(defaultRoot) && readdirSync(defaultRoot).length > 0) {
    throw new Error(`默认创作台目录已有内容：${defaultRoot}。请先备份或移走后再恢复默认。`)
  }
  const choice = win
    ? await dialog.showMessageBox(win, {
        type: 'question',
        title: '恢复默认创作台目录',
        message: '恢复默认并重启？',
        detail: `会把当前创作台数据复制回：${defaultRoot}
原自定义目录保留。Agent 对话和设置不受影响。`,
        buttons: ['恢复默认并重启', '取消'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
    : await dialog.showMessageBox({
        type: 'question',
        title: '恢复默认创作台目录',
        message: '恢复默认并重启？',
        detail: `会把当前创作台数据复制回：${defaultRoot}
原自定义目录保留。`,
        buttons: ['恢复默认并重启', '取消'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
  if (choice.response !== 0) return { restarted: false, canceled: true }
  mkdirSync(defaultRoot, { recursive: true })
  let files = 0
  try {
    files = copyUserDataForMigration(current, defaultRoot)
  } catch (err) {
    try { cleanTargetDataDir(defaultRoot) } catch { /* ignore */ }
    throw new Error(`迁回默认创作台目录失败：${err instanceof Error ? err.message : String(err)}`)
  }
  removeStudioLocation()
  relaunchStudioSoon()
  return { restarted: !studioDataTestMode(), path: defaultRoot, files }
})



function terminalPayloadOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}



function terminalText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}



function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}



/**
 * 没有工作区（或旧工作区已被移动/删除）时终端仍要能打开。
 * 依次回退到用户主目录、数据目录、应用当前目录，避免把「没有工作区」变成无法使用终端。
 */
function fallbackCwd(): string {
  for (const candidate of [homedir(), process.env.USERPROFILE, process.env.MORROW_DATA_DIR, process.cwd()]) {
    if (candidate && isDirectory(candidate)) return candidate
  }
  return process.cwd()
}



function resolveCwd(raw: unknown): string {
  const requested = terminalText(raw).trim()
  if (requested) {
    try {
      return resolveWorkspaceDir(requested, '终端只能在工作区内启动。')
    } catch (err) {
      // 目录不存在属于工作区被移走的情况，回退到主目录；越界等其它错误保持原样。
      if (!existsSync(requested)) return fallbackCwd()
      throw err
    }
  }
  try {
    return resolveWorkspaceDir('', '终端只能在工作区内启动。')
  } catch {
    return fallbackCwd()
  }
}



function managerOf(): ReturnType<typeof getTerminalManager> {
  return getTerminalManager()
}



function sameCwd(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const clean = value.replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? clean.toLowerCase() : clean
  }
  return normalize(left) === normalize(right)
}



registerFeatureHandler('feature:terminal:list', (payload) => {
  const input = terminalPayloadOf(payload)
  const raw = terminalText(input.workspace).trim()
  if (!raw) return { processes: managerOf().list() }
  const workspace = resolveWorkspaceDir(raw, '终端只能查看已登记工作区内的进程。')
  return { processes: managerOf().list().filter((process) => sameCwd(process.cwd, workspace)) }
})



registerFeatureHandler('feature:terminal:profiles', (payload) => {
  const input = terminalPayloadOf(payload)
  const refresh = input.refresh === true
  if (refresh) managerOf().refreshProfiles()
  return {
    profiles: managerOf().profiles(),
    defaultShell: managerOf().defaultShellId(),
    wsl: managerOf().wslStatus()
  }
})



registerFeatureHandler('feature:terminal:create', (payload) => {
  const input = terminalPayloadOf(payload)
  const cwd = resolveCwd(input.cwd)
  const requested = terminalText(input.shell).trim() || getSettingsStore().get().terminalShell
  return managerOf().createShell(
    cwd,
    terminalText(input.title).trim().slice(0, 120) || undefined,
    requested || undefined
  )
})



registerFeatureHandler('feature:terminal:start-task', (payload) => {
  const input = terminalPayloadOf(payload)
  const command = terminalText(input.command).trim()
  if (!command) throw new Error('后台任务命令不能为空。')
  if (command.length > 4000) throw new Error('后台任务命令不能超过 4000 字符。')
  return managerOf().startTask(
    command,
    resolveCwd(input.cwd),
    terminalText(input.title).trim().slice(0, 120) || undefined,
    getSettingsStore().get().terminalShell || undefined
  )
})



registerFeatureHandler('feature:terminal:read', (payload) => {
  const input = terminalPayloadOf(payload)
  const id = terminalText(input.id).trim()
  if (!id) throw new Error('缺少进程 id。')
  const tail = typeof input.tail === 'number' && Number.isFinite(input.tail) ? input.tail : 40_000
  return managerOf().read(id, tail)
})



registerFeatureHandler('feature:terminal:write', (payload) => {
  const input = terminalPayloadOf(payload)
  const id = terminalText(input.id).trim()
  if (!id) throw new Error('缺少进程 id。')
  if (typeof input.data !== 'string') throw new Error('缺少要写入的内容。')
  if (input.data.length > 20_000) throw new Error('单次写入不能超过 20000 字符。')
  return managerOf().write(id, input.data)
})



registerFeatureHandler('feature:terminal:input', (payload) => {
  const input = terminalPayloadOf(payload)
  const id = terminalText(input.id).trim()
  if (!id) throw new Error('缺少终端 id。')
  if (typeof input.data !== 'string') throw new Error('缺少输入内容。')
  if (input.data.length > 100_000) throw new Error('单次输入不能超过 100000 字符。')
  return managerOf().write(id, input.data, true)
})



registerFeatureHandler('feature:terminal:resize', (payload) => {
  const input = terminalPayloadOf(payload)
  const id = terminalText(input.id).trim()
  if (!id) throw new Error('缺少终端 id。')
  const cols = typeof input.cols === 'number' ? input.cols : 0
  const rows = typeof input.rows === 'number' ? input.rows : 0
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) throw new Error('终端尺寸不合法。')
  return managerOf().resize(id, cols, rows)
})



registerFeatureHandler('feature:terminal:stop', (payload) => {
  const input = terminalPayloadOf(payload)
  return managerOf().stop(terminalText(input.id).trim())
})



registerFeatureHandler('feature:terminal:restart', (payload) => {
  const input = terminalPayloadOf(payload)
  return managerOf().restart(terminalText(input.id).trim())
})



registerFeatureHandler('feature:terminal:remove', (payload) => {
  const input = terminalPayloadOf(payload)
  managerOf().remove(terminalText(input.id).trim())
  return { removed: true }
})



function featurePayloadOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}



function featureText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}



function requestedWorkspace(input: Record<string, unknown>): string {
  return typeof input.workspace === 'string' ? input.workspace.trim() : ''
}



registerFeatureHandler('feature:agents:list', (payload) => {
  const requested = requestedWorkspace(featurePayloadOf(payload))
  const workspace = requested
    ? resolveWorkspaceDir(requested, '集群成员角色只能读取已登记工作区内的配置。')
    : null
  return summarizeAgentRoles(loadAgentRoles(workspace))
})



registerFeatureHandler('feature:commands:list', (payload) => {
  const requested = requestedWorkspace(featurePayloadOf(payload))
  const workspace = requested
    ? resolveWorkspaceDir(requested, '自定义命令只能读取已登记工作区内的项目命令。')
    : null
  return discoverCustomCommands(workspace)
})



registerFeatureHandler('feature:rules:list', (payload) => {
  const requested = requestedWorkspace(featurePayloadOf(payload))
  // 只允许读取已登记工作区内的项目规则；不传工作区时仅返回用户级规则
  const workspace = requested
    ? resolveWorkspaceDir(requested, '规则文件只能读取已登记工作区内的项目规则。')
    : null
  const discovery = discoverAgentRules(workspace)
  return {
    files: discovery.files,
    usedTokens: discovery.usedTokens,
    limitTokens: discovery.limitTokens,
    truncated: discovery.truncated
  }
})



function permissionWorkspace(input: Record<string, unknown>): string {
  const raw = typeof input.workspace === 'string' ? input.workspace.trim() : ''
  if (!raw) throw new Error('缺少工作区路径。')
  const real = realpathSync(resolve(raw))
  if (!statSync(real).isDirectory()) throw new Error('工作区不是文件夹。')
  return real
}



registerFeatureHandler('feature:permissions:list-rules', (payload) => {
  return { rules: getPermissionRulesService().list(permissionWorkspace(featurePayloadOf(payload))) }
})



registerFeatureHandler('feature:permissions:add-rule', (payload) => {
  const input = featurePayloadOf(payload)
  const workspace = permissionWorkspace(input)
  const tool = typeof input.tool === 'string' ? input.tool : ''
  const kind = input.kind as PermissionRuleKind
  const pattern = typeof input.pattern === 'string' ? input.pattern : ''
  if (input.decision !== 'allow' && input.decision !== 'deny') throw new Error('规则动作不合法。')
  return getPermissionRulesService().add({ workspace, tool, kind, pattern, decision: input.decision })
})



registerFeatureHandler('feature:permissions:remove-rule', (payload) => {
  const input = featurePayloadOf(payload)
  const workspace = permissionWorkspace(input)
  const id = typeof input.id === 'string' ? input.id : ''
  if (!id) throw new Error('缺少规则 id。')
  return { removed: getPermissionRulesService().remove(id, workspace) }
})



registerFeatureHandler('feature:permissions:list-log', (payload) => {
  const input = featurePayloadOf(payload)
  const raw = typeof input.workspace === 'string' ? input.workspace.trim() : ''
  let workspace: string | null = null
  if (raw) {
    try {
      workspace = realpathSync(resolve(raw))
    } catch {
      workspace = null
    }
  }
  return { entries: getPermissionRulesService().listLog(workspace) }
})



function gitWorkspace(payload: unknown): string {
  const input = featurePayloadOf(payload)
  return resolveWorkspaceDir(input.workspace ?? input.cwd, 'Git 操作只能在工作区内执行。')
}



/** 只有完全省略 path 才表示「全部」；传了非法值必须报错而不是退化成全部。 */
function gitPath(payload: unknown): unknown {
  const input = featurePayloadOf(payload)
  return Object.prototype.hasOwnProperty.call(input, 'path') ? input.path : undefined
}



registerFeatureHandler('feature:git:status', (payload) => gitService.status(gitWorkspace(payload)))



registerFeatureHandler('feature:git:init', (payload) => gitService.init(gitWorkspace(payload)))



registerFeatureHandler('feature:git:diff', (payload) => {
  const input = featurePayloadOf(payload)
  return gitService.diff(gitWorkspace(payload), input.path, input.staged === true)
})



registerFeatureHandler('feature:git:stage', (payload) => gitService.stage(gitWorkspace(payload), gitPath(payload)))



registerFeatureHandler('feature:git:unstage', (payload) => gitService.unstage(gitWorkspace(payload), gitPath(payload)))



registerFeatureHandler('feature:git:discard', (payload) => {
  const input = featurePayloadOf(payload)
  return gitService.discard(gitWorkspace(payload), input.path)
})



registerFeatureHandler('feature:git:commit', (payload) => {
  const input = featurePayloadOf(payload)
  return gitService.commit(gitWorkspace(payload), featureText(input.message), input.stageAll === true)
})



registerFeatureHandler('feature:git:set-identity', (payload) => {
  const input = featurePayloadOf(payload)
  return gitService.setIdentity(gitWorkspace(payload), input.name, input.email)
})



registerFeatureHandler('feature:git:branches', (payload) => gitService.branches(gitWorkspace(payload)))



registerFeatureHandler('feature:git:checkout', (payload) => {
  const input = featurePayloadOf(payload)
  return gitService.switchBranch(gitWorkspace(payload), input.branch)
})



registerFeatureHandler('feature:git:create-branch', (payload) => {
  const input = featurePayloadOf(payload)
  return gitService.createBranch(gitWorkspace(payload), input.name)
})



registerFeatureHandler('feature:git:log', (payload) => gitService.log(gitWorkspace(payload)))



registerFeatureHandler('feature:git:show', (payload) => {
  const input = featurePayloadOf(payload)
  return gitService.show(gitWorkspace(payload), input.hash)
})



registerFeatureHandler('feature:subscriptions:status', async () => {
  return getSubscriptionService().status()
})



registerFeatureHandler('feature:subscriptions:login-url', (payload) => {
  const input = featurePayloadOf(payload)
  const provider = featureText(input.provider)
  return {
    url: provider === 'qoder' ? getQoderSubscriptionService().pendingLoginUrl() : getSubscriptionService().pendingLoginUrl()
  }
})



registerFeatureHandler('feature:subscriptions:action', async (payload) => {
  const input = featurePayloadOf(payload)
  if (typeof input.action !== 'string') throw new Error('缺少订阅操作。')
  const result = await runSubscriptionAction(input as SubscriptionAction)
  if (/^(login-|import-)/.test(input.action)) closeLoginWindow()
  return result
})



registerFeatureHandler('feature:subscriptions:pick-codex-auth', async (_payload, event) => {
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const options = {
    title: '选择 Codex CLI 登录文件（auth.json）',
    properties: ['openFile' as const],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : result.filePaths[0] ?? null
})



function scheduleRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('参数格式不正确')
  return payload as Record<string, unknown>
}



function scheduleId(payload: unknown): string {
  const id = scheduleRecord(payload).id
  if (typeof id !== 'string' || !id.trim()) throw new Error('缺少定时任务 id。')
  return id
}



registerFeatureHandler('feature:schedules:list', () => listSchedules())



registerFeatureHandler('feature:schedules:create', (payload) => createSchedule(scheduledInputFromRecord(payload)))



registerFeatureHandler('feature:schedules:update', (payload) => {
  const data = scheduleRecord(payload)
  return updateSchedule(scheduleId(data), scheduledInputFromRecord(data))
})



registerFeatureHandler('feature:schedules:remove', (payload) => removeSchedule(scheduleId(payload)))



registerFeatureHandler('feature:schedules:set-enabled', (payload) => {
  const data = scheduleRecord(payload)
  if (typeof data.enabled !== 'boolean') throw new Error('enabled 必须是布尔值。')
  return setScheduleEnabled(scheduleId(data), data.enabled)
})



registerFeatureHandler('feature:schedules:run-now', (payload) => runScheduleNow(scheduleId(payload)))



export function registerFeatureModules(): void {
  registerMemoryFeature(registerFeatureHandler)
  registerEvolutionFeature(registerFeatureHandler)
  registerProjectsFeature(registerFeatureHandler)
  registerSkillsFeature(registerFeatureHandler)
  registerBrowserFeature()
  warmSearchIndex()
}
