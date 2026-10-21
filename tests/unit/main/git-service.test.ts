import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitService } from '../../../src/main/services/git-service'

let hasGit = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true })
} catch {
  hasGit = false
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

const suite = hasGit ? describe : describe.skip

suite('GitService', () => {
  let dir: string
  let service: GitService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morrow-git-'))
    git(dir, 'init')
    git(dir, 'config', 'user.name', 'Morrow Test')
    git(dir, 'config', 'user.email', 'test@example.com')
    service = new GitService()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  it('未跟踪文件 → 暂存 → 提交 → 历史与差异', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n', 'utf8')
    const initial = await service.status(dir)
    expect(initial.isRepo).toBe(true)
    expect(initial.hasCommits).toBe(false)
    expect(initial.files).toHaveLength(1)
    expect(initial.files[0]).toMatchObject({ path: 'a.txt', untracked: true, staged: false, unstaged: true })
    expect(initial.changedCount).toBe(1)

    const untrackedDiff = await service.diff(dir, 'a.txt', false)
    expect(untrackedDiff.diff).toContain('+one')
    expect(untrackedDiff.path).toBe('a.txt')

    const staged = await service.stage(dir, 'a.txt')
    expect(staged.stagedCount).toBe(1)
    expect(staged.files[0]).toMatchObject({ path: 'a.txt', staged: true, unstaged: false })

    const committed = await service.commit(dir, 'first commit', false)
    expect(committed.status.stagedCount).toBe(0)
    expect(committed.status.hasCommits).toBe(true)
    expect(committed.commitHash).toMatch(/^[0-9a-f]+$/i)
    expect(committed.summary).toContain('first commit')

    const log = await service.log(dir)
    expect(log).toHaveLength(1)
    expect(log[0]?.subject).toBe('first commit')
    const detail = await service.show(dir, committed.commitHash!)
    expect(detail.commit.subject).toBe('first commit')
    expect(detail.diff).toContain('+one')

    writeFileSync(join(dir, 'a.txt'), 'two\n', 'utf8')
    const modified = await service.status(dir)
    expect(modified.files[0]).toMatchObject({ path: 'a.txt', staged: false, unstaged: true })
    const worktreeDiff = await service.diff(dir, 'a.txt', false)
    expect(worktreeDiff.diff).toContain('+two')
    expect(worktreeDiff.diff).toContain('-one')

    await service.stage(dir, 'a.txt')
    const unstaged = await service.unstage(dir, 'a.txt')
    expect(unstaged.stagedCount).toBe(0)
    expect(unstaged.changedCount).toBe(1)
    const discarded = await service.discard(dir, 'a.txt')
    expect(discarded.files).toHaveLength(0)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one\n')
  })

  it('分支创建/切换与提交信息校验', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n', 'utf8')
    await service.stage(dir)
    await service.commit(dir, 'init', false)
    const base = (await service.status(dir)).branch
    expect(base).toBeTruthy()

    const created = await service.createBranch(dir, 'feature/test')
    expect(created.branch).toBe('feature/test')
    const branches = await service.branches(dir)
    expect(branches.map((branch) => branch.name)).toEqual(expect.arrayContaining([base!, 'feature/test']))
    expect(branches.find((branch) => branch.name === 'feature/test')?.current).toBe(true)

    const switched = await service.switchBranch(dir, base!)
    expect(switched.branch).toBe(base)

    await expect(service.createBranch(dir, 'bad name')).rejects.toThrow(/分支名/)
    await expect(service.commit(dir, '   ', false)).rejects.toThrow(/提交信息/)
  })

  it('拒绝越界路径与非变更文件，未跟踪文件可丢弃', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n', 'utf8')
    await expect(service.diff(dir, '../outside.txt', false)).rejects.toThrow(/仓库内/)
    await expect(service.diff(dir, join(dir, 'a.txt'), false)).rejects.toThrow(/相对路径/)
    await expect(service.stage(dir, 'missing.txt')).rejects.toThrow(/变更列表/)
    await expect(service.discard(dir, 'missing.txt')).rejects.toThrow(/变更列表/)
    await expect(service.stage(dir, 42)).rejects.toThrow(/路径无效/)
    await expect(service.unstage(dir, '   ')).rejects.toThrow(/路径无效/)

    const status = await service.discard(dir, 'a.txt')
    expect(status.files).toHaveLength(0)
    expect(existsSync(join(dir, 'a.txt'))).toBe(false)
  })

  it('工作区位于更大仓库内部时拒绝操作，避免影响仓库根', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'morrow-git-parent-'))
    try {
      git(parent, 'init')
      const sub = join(parent, 'sub')
      mkdirSync(sub)
      await expect(service.status(sub)).rejects.toThrow(/工作区之外/)
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('忽略外部 GIT_DIR / GIT_WORK_TREE，始终操作工作区仓库', async () => {
    writeFileSync(join(dir, 'local.txt'), 'local\n', 'utf8')
    const other = mkdtempSync(join(tmpdir(), 'morrow-git-other-'))
    const saved = {
      dir: process.env.GIT_DIR,
      tree: process.env.GIT_WORK_TREE,
      index: process.env.GIT_INDEX_FILE
    }
    try {
      git(other, 'init')
      process.env.GIT_DIR = join(other, '.git')
      process.env.GIT_WORK_TREE = other
      process.env.GIT_INDEX_FILE = join(other, '.git', 'index')
      const status = await service.status(dir)
      expect(status.isRepo).toBe(true)
      expect(status.root?.toLowerCase()).toBe(realpathSync(dir).toLowerCase())
      expect(status.files.map((file) => file.path)).toContain('local.txt')
    } finally {
      for (const [key, value] of [
        ['GIT_DIR', saved.dir],
        ['GIT_WORK_TREE', saved.tree],
        ['GIT_INDEX_FILE', saved.index]
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(other, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('非仓库工作区返回 isRepo=false，init 后可提交首个改动', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'morrow-git-plain-'))
    try {
      const state = await service.status(plain)
      expect(state.isRepo).toBe(false)
      const initialized = await service.init(plain)
      expect(initialized.isRepo).toBe(true)
      writeFileSync(join(plain, 'readme.md'), '# hi\n', 'utf8')
      const staged = await service.stage(plain)
      expect(staged.stagedCount).toBe(1)
    } finally {
      rmSync(plain, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})
