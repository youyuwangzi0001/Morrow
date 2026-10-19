/**
 * R10-A 工作区文件服务单测：边界 / symlink 防逃逸 / 二进制与大小 / 原子写与快照 / mtime 冲突 / 创建重命名删除。
 * 不依赖 Electron，直接在临时目录里验证 services/workspace-files.ts。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WorkspaceFileError,
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  inspectWorkspaceEntry,
  listWorkspaceEntries,
  moveWorkspaceEntry,
  readWorkspaceFile,
  renameWorkspaceEntry,
  statWorkspaceFile,
  workspaceAttachment,
  writeWorkspaceFile
} from '../../../src/main/services/workspace-files'

let sandbox = ''
let workspace = ''
let snapshotRoot = ''
let outsideDir = ''

function makeSandbox(): void {
  sandbox = mkdtempSync(join(tmpdir(), 'morrow-files-test-'))
  workspace = join(sandbox, 'workspace')
  snapshotRoot = join(sandbox, 'snapshots')
  outsideDir = join(sandbox, 'outside')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(workspace, 'docs', 'deep'), { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(workspace, 'readme.md'), '# Morrow\n\n你好\n', 'utf8')
  writeFileSync(join(workspace, 'docs', 'note.txt'), 'note', 'utf8')
  writeFileSync(join(workspace, 'docs', 'deep', 'item.json'), '{"a":1}', 'utf8')
  writeFileSync(join(workspace, '.hidden'), 'secret', 'utf8')
  writeFileSync(join(outsideDir, 'outside.txt'), 'outside', 'utf8')
  mkdirSync(snapshotRoot, { recursive: true })
}

beforeAll(() => makeSandbox())

afterAll(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

function errorCode(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof WorkspaceFileError) return err.code
    return `UNEXPECTED:${String(err)}`
  }
  return 'NO_ERROR'
}

describe('listWorkspaceEntries（懒加载目录）', () => {
  it('目录在前、文件在后；隐藏文件默认不显示；路径为工作区相对 posix 路径', () => {
    const result = listWorkspaceEntries(workspace)
    expect(result.dir).toBe('')
    const names = result.entries.map((entry) => entry.name)
    expect(names.indexOf('docs')).toBeLessThan(names.indexOf('readme.md'))
    expect(names).not.toContain('.hidden')
    expect(result.entries.find((entry) => entry.name === 'readme.md')?.path).toBe('readme.md')
    expect(result.entries.find((entry) => entry.name === 'docs')?.kind).toBe('dir')
  })

  it('showHidden=true 时包含隐藏文件；子目录懒加载返回相对路径', () => {
    const root = listWorkspaceEntries(workspace, { showHidden: true })
    expect(root.entries.map((entry) => entry.name)).toContain('.hidden')
    const docs = listWorkspaceEntries(workspace, { dir: 'docs' })
    expect(docs.dir).toBe('docs')
    expect(docs.entries.map((entry) => entry.path)).toEqual(['docs/deep', 'docs/note.txt'])
  })

  it('拒绝越界目录与文件路径', () => {
    expect(errorCode(() => listWorkspaceEntries(workspace, { dir: '..' }))).toBe('OUTSIDE_WORKSPACE')
    expect(errorCode(() => listWorkspaceEntries(workspace, { dir: 'readme.md' }))).toBe('NOT_A_DIR')
  })
})

describe('readWorkspaceFile', () => {
  it('读取 UTF-8 文本并返回 mtime/size', () => {
    const result = readWorkspaceFile(workspace, 'readme.md')
    expect(result.content).toContain('Morrow')
    expect(result.path).toBe('readme.md')
    expect(result.encoding).toBe('utf8')
    expect(result.size).toBeGreaterThan(0)
    expect(result.mtimeMs).toBeGreaterThan(0)
  })

  it('二进制文件（含 NUL 字节）与超大文件给出可读错误', () => {
    writeFileSync(join(workspace, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    expect(errorCode(() => readWorkspaceFile(workspace, 'binary.bin'))).toBe('BINARY')
    writeFileSync(join(workspace, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 10))
    expect(errorCode(() => readWorkspaceFile(workspace, 'big.txt'))).toBe('TOO_LARGE')
    expect(errorCode(() => readWorkspaceFile(workspace, 'docs'))).toBe('NOT_A_FILE')
    expect(errorCode(() => readWorkspaceFile(workspace, 'missing.txt'))).toBe('NOT_FOUND')
  })
})

describe('writeWorkspaceFile（原子写 + 快照 + mtime 冲突）', () => {
  it('创建新文件并返回 mtime；再次写入时生成写前快照', () => {
    const created = writeWorkspaceFile(workspace, 'docs/new.txt', '第一版', { snapshotRoot })
    expect(created.created).toBe(true)
    expect(readFileSync(join(workspace, 'docs', 'new.txt'), 'utf8')).toBe('第一版')
    expect(created.snapshot).toBeUndefined()

    const updated = writeWorkspaceFile(workspace, 'docs/new.txt', '第二版', { snapshotRoot })
    expect(updated.created).toBe(false)
    expect(updated.snapshot).toBeTruthy()
    expect(existsSync(updated.snapshot as string)).toBe(true)
    expect(readFileSync(updated.snapshot as string, 'utf8')).toBe('第一版')
    expect(readFileSync(join(workspace, 'docs', 'new.txt'), 'utf8')).toBe('第二版')
  })

  it('expectedMtimeMs 不一致时拒绝保存（外部修改冲突），一致时允许', () => {
    const before = statWorkspaceFile(workspace, 'docs/new.txt')
    expect(errorCode(() => writeWorkspaceFile(workspace, 'docs/new.txt', '冲突内容', {
      snapshotRoot,
      expectedMtimeMs: before.mtimeMs - 5000
    }))).toBe('MTIME_CONFLICT')
    // 文件内容没有被覆盖
    expect(readFileSync(join(workspace, 'docs', 'new.txt'), 'utf8')).toBe('第二版')

    const ok = writeWorkspaceFile(workspace, 'docs/new.txt', '第三版', {
      snapshotRoot,
      expectedMtimeMs: before.mtimeMs
    })
    expect(ok.size).toBeGreaterThan(0)
    expect(readFileSync(join(workspace, 'docs', 'new.txt'), 'utf8')).toBe('第三版')
  })

  it('拒绝写入工作区外路径与目录', () => {
    expect(errorCode(() => writeWorkspaceFile(workspace, '../outside.txt', 'hack', { snapshotRoot }))).toBe('OUTSIDE_WORKSPACE')
    expect(errorCode(() => writeWorkspaceFile(workspace, join(outsideDir, 'abs.txt'), 'hack', { snapshotRoot }))).toBe('OUTSIDE_WORKSPACE')
    expect(errorCode(() => writeWorkspaceFile(workspace, 'docs', 'hack', { snapshotRoot }))).toBe('NOT_A_FILE')
  })
})

describe('create / rename / move', () => {
  it('新建文件/文件夹；同名或父目录缺失时报错', () => {
    const file = createWorkspaceEntry(workspace, 'docs/created.md', 'file')
    expect(file.kind).toBe('file')
    const dir = createWorkspaceEntry(workspace, 'assets', 'dir')
    expect(dir.kind).toBe('dir')
    expect(errorCode(() => createWorkspaceEntry(workspace, 'docs/created.md', 'file'))).toBe('EXISTS')
    expect(errorCode(() => createWorkspaceEntry(workspace, 'nope/child.txt', 'file'))).toBe('PARENT_MISSING')
    expect(errorCode(() => createWorkspaceEntry(workspace, '../evil.txt', 'file'))).toBe('OUTSIDE_WORKSPACE')
  })

  it('重命名成功；目标已存在时拒绝覆盖', () => {
    const result = renameWorkspaceEntry(workspace, 'docs/created.md', 'docs/renamed.md')
    expect(result.to).toBe('docs/renamed.md')
    expect(existsSync(join(workspace, 'docs', 'renamed.md'))).toBe(true)
    writeFileSync(join(workspace, 'docs', 'taken.md'), 'x')
    expect(errorCode(() => renameWorkspaceEntry(workspace, 'docs/renamed.md', 'docs/taken.md'))).toBe('EXISTS')
    expect(errorCode(() => renameWorkspaceEntry(workspace, 'docs/renamed.md', '../moved.md'))).toBe('OUTSIDE_WORKSPACE')
  })

  it('移动文件到目录；禁止把目录移动到自身子目录', () => {
    const moved = moveWorkspaceEntry(workspace, 'docs/renamed.md', '')
    expect(moved.to).toBe('renamed.md')
    expect(existsSync(join(workspace, 'renamed.md'))).toBe(true)
    expect(errorCode(() => moveWorkspaceEntry(workspace, 'docs', 'docs/deep'))).toBe('INVALID_PATH')
  })
})

describe('deleteWorkspaceEntry（确认 / 非空目录 / 根目录）', () => {
  it('未确认时拒绝；非空目录需 recursive；可删除空目录与文件', () => {
    expect(errorCode(() => deleteWorkspaceEntry(workspace, 'renamed.md'))).toBe('CONFIRM_REQUIRED')
    expect(errorCode(() => deleteWorkspaceEntry(workspace, 'docs/deep', { confirm: true }))).toBe('DIR_NOT_EMPTY')
    const removed = deleteWorkspaceEntry(workspace, 'docs/deep', { confirm: true, recursive: true })
    expect(removed.deleted).toBe(true)
    expect(existsSync(join(workspace, 'docs', 'deep'))).toBe(false)
    deleteWorkspaceEntry(workspace, 'renamed.md', { confirm: true })
    expect(existsSync(join(workspace, 'renamed.md'))).toBe(false)
    expect(errorCode(() => deleteWorkspaceEntry(workspace, '', { confirm: true, recursive: true }))).toBe('INVALID_PATH')
  })

  it('inspectWorkspaceEntry 返回目录子项数量供二次确认', () => {
    const info = inspectWorkspaceEntry(workspace, 'docs')
    expect(info.kind).toBe('dir')
    expect(info.childCount).toBeGreaterThan(0)
  })
})

describe('symlink / junction 防逃逸', () => {
  it('工作区内指向工作区外的目录链接：list 标记 restricted，读取被拒绝', () => {
    const linkPath = join(workspace, 'escape-link')
    try {
      symlinkSync(outsideDir, linkPath, 'junction')
    } catch {
      // Windows 无权限创建链接的环境下跳过（其它断言仍覆盖路径边界）
      return
    }
    const listed = listWorkspaceEntries(workspace)
    const link = listed.entries.find((entry) => entry.name === 'escape-link')
    expect(link).toBeTruthy()
    expect(link?.isSymlink).toBe(true)
    expect(link?.restricted).toBe(true)
    expect(errorCode(() => readWorkspaceFile(workspace, 'escape-link/outside.txt'))).toBe('OUTSIDE_WORKSPACE')
    expect(errorCode(() => writeWorkspaceFile(workspace, 'escape-link/hack.txt', 'x', { snapshotRoot }))).toBe(
      'OUTSIDE_WORKSPACE'
    )
    // 删除链接本身也按越界拒绝（保守策略：链接无法证明安全）
    expect(errorCode(() => deleteWorkspaceEntry(workspace, 'escape-link', { confirm: true, recursive: true }))).toBe(
      'OUTSIDE_WORKSPACE'
    )
    expect(existsSync(join(outsideDir, 'outside.txt'))).toBe(true)
  })

  it('绝对路径越界与 ../ 越界都被拒绝', () => {
    expect(errorCode(() => readWorkspaceFile(workspace, '../outside/outside.txt'))).toBe('OUTSIDE_WORKSPACE')
    expect(errorCode(() => readWorkspaceFile(workspace, join(outsideDir, 'outside.txt')))).toBe('OUTSIDE_WORKSPACE')
  })
})

describe('workspaceAttachment（拖拽/附件）', () => {
  it('文本文件带内容；图片按扩展名标记 image', () => {
    const text = workspaceAttachment(workspace, 'readme.md')
    expect(text.kind).toBe('text')
    expect(text.content).toContain('Morrow')
    writeFileSync(join(workspace, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const image = workspaceAttachment(workspace, 'pic.png')
    expect(image.kind).toBe('image')
    expect(image.content).toBeNull()
    expect(lstatSync(join(workspace, 'pic.png')).isFile()).toBe(true)
  })
})
