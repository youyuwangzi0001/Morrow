/**
 * 撤销快照安全边界：会话范围、目录结构、清单完整性、冲突与幂等。
 * 全部在临时目录中完成，不依赖 Electron。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256 } from '../../../src/core/util'
import { restoreSnapshotSafely, RESTORE_MANIFEST_FILE } from '../../../src/main/services/snapshot-restore'

const tempDirs: string[] = []

function makeFixture(): {
  base: string
  workspace: string
  sessionRoot: string
  toolDir: string
  snapshotPath: string
  target: string
} {
  const base = mkdtempSync(join(tmpdir(), 'morrow-undo-'))
  tempDirs.push(base)
  const workspace = join(base, 'ws')
  const sessionRoot = join(base, 'snapshots', 's_session')
  const toolDir = join(sessionRoot, 'tool_1')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(toolDir, { recursive: true })
  return {
    base,
    workspace,
    sessionRoot,
    toolDir,
    snapshotPath: join(toolDir, 'note.txt'),
    target: join(workspace, 'note.txt')
  }
}

function record(
  fixture: ReturnType<typeof makeFixture>,
  before: string,
  after: string,
  overrides: { targetPath?: string; beforeHash?: string; afterHash?: string } = {}
): void {
  writeFileSync(fixture.snapshotPath, before, 'utf8')
  writeFileSync(
    join(fixture.toolDir, RESTORE_MANIFEST_FILE),
    JSON.stringify({
      targetPath: overrides.targetPath ?? fixture.target,
      beforeHash: overrides.beforeHash ?? sha256(before),
      afterHash: overrides.afterHash ?? sha256(after),
      at: Date.now()
    }),
    'utf8'
  )
}

function restore(fixture: ReturnType<typeof makeFixture>, snapshotPath = fixture.snapshotPath) {
  return restoreSnapshotSafely({
    snapshotRoot: fixture.sessionRoot,
    snapshotPath,
    targetPath: fixture.target,
    workspace: fixture.workspace
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('restoreSnapshotSafely：正常撤销与冲突', () => {
  it('文件未被手改时恢复快照；重复撤销幂等', () => {
    const fixture = makeFixture()
    record(fixture, '旧内容\n', '新内容\n')
    writeFileSync(fixture.target, '新内容\n', 'utf8')

    const first = restore(fixture)
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.written).toBe(true)
    expect(readFileSync(fixture.target, 'utf8')).toBe('旧内容\n')

    const again = restore(fixture)
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.written).toBe(false)
  })

  it('用户在写入后手工改过：拒绝覆盖（UNDO_CONFLICT）', () => {
    const fixture = makeFixture()
    record(fixture, '旧内容\n', 'Morrow 写入\n')
    writeFileSync(fixture.target, '用户手改\n', 'utf8')

    const outcome = restore(fixture)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('UNDO_CONFLICT')
    expect(readFileSync(fixture.target, 'utf8')).toBe('用户手改\n')
  })

  it('目标文件已被删除时可以恢复；但缺少清单时一律拒绝且不创建文件', () => {
    const fixture = makeFixture()
    record(fixture, '旧内容\n', '新内容\n')
    const restored = restore(fixture)
    expect(restored.ok).toBe(true)
    expect(readFileSync(fixture.target, 'utf8')).toBe('旧内容\n')

    const second = makeFixture()
    writeFileSync(second.snapshotPath, '无清单快照\n', 'utf8')
    const outcome = restore(second)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('UNDO_UNVERIFIABLE')
    expect(() => readFileSync(second.target, 'utf8')).toThrow()
  })

  it('清单目标与要恢复的文件不一致时拒绝', () => {
    const fixture = makeFixture()
    record(fixture, '旧内容\n', '新内容\n', { targetPath: join(fixture.workspace, 'other.txt') })
    writeFileSync(fixture.target, '新内容\n', 'utf8')

    const outcome = restore(fixture)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('UNDO_CONFLICT')
  })

  it('快照内容与 beforeHash 不一致时拒绝（备份被替换）', () => {
    const fixture = makeFixture()
    record(fixture, '旧内容\n', '新内容\n', { beforeHash: sha256('另一个版本\n') })
    writeFileSync(fixture.target, '新内容\n', 'utf8')

    const outcome = restore(fixture)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('UNDO_UNVERIFIABLE')
    expect(readFileSync(fixture.target, 'utf8')).toBe('新内容\n')
  })
})

describe('restoreSnapshotSafely：路径与目录边界', () => {
  it('快照必须位于当前会话根目录内（防跨会话读取）', () => {
    const fixture = makeFixture()
    record(fixture, '旧内容\n', '新内容\n')
    writeFileSync(fixture.target, '新内容\n', 'utf8')
    const otherSessionRoot = join(fixture.base, 'snapshots', 's_other')
    mkdirSync(otherSessionRoot, { recursive: true })

    const outcome = restoreSnapshotSafely({
      snapshotRoot: otherSessionRoot,
      snapshotPath: fixture.snapshotPath,
      targetPath: fixture.target,
      workspace: fixture.workspace
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('INVALID_SNAPSHOT')
    expect(readFileSync(fixture.target, 'utf8')).toBe('新内容\n')
  })

  it('拒绝 .. 路径穿越、嵌套目录与 .restore.json 本体', () => {
    const fixture = makeFixture()
    record(fixture, '旧内容\n', '新内容\n')
    const escapeDir = join(fixture.sessionRoot, '..', 'escape')
    mkdirSync(escapeDir, { recursive: true })
    const escapeFile = join(escapeDir, 'note.txt')
    writeFileSync(escapeFile, '越界快照\n', 'utf8')

    const traversal = restore(fixture, escapeFile)
    expect(traversal.ok).toBe(false)
    if (!traversal.ok) expect(traversal.code).toBe('INVALID_SNAPSHOT')

    const nested = join(fixture.toolDir, 'nested')
    mkdirSync(nested, { recursive: true })
    const nestedFile = join(nested, 'note.txt')
    writeFileSync(nestedFile, '嵌套快照\n', 'utf8')
    const nestedOutcome = restore(fixture, nestedFile)
    expect(nestedOutcome.ok).toBe(false)
    if (!nestedOutcome.ok) expect(nestedOutcome.code).toBe('INVALID_SNAPSHOT')

    const manifestAsSnapshot = restore(fixture, join(fixture.toolDir, RESTORE_MANIFEST_FILE))
    expect(manifestAsSnapshot.ok).toBe(false)
    if (!manifestAsSnapshot.ok) expect(manifestAsSnapshot.code).toBe('INVALID_SNAPSHOT')
  })

  it('目标在工作区外或不是普通文件时拒绝', () => {
    const fixture = makeFixture()
    const outside = join(fixture.base, 'outside.txt')
    record(fixture, '旧内容\n', '新内容\n', { targetPath: outside })
    writeFileSync(outside, '新内容\n', 'utf8')
    const outsideOutcome = restoreSnapshotSafely({
      snapshotRoot: fixture.sessionRoot,
      snapshotPath: fixture.snapshotPath,
      targetPath: outside,
      workspace: fixture.workspace
    })
    expect(outsideOutcome.ok).toBe(false)
    if (!outsideOutcome.ok) expect(outsideOutcome.code).toBe('OUTSIDE_WORKSPACE')

    const dirFixture = makeFixture()
    const dirTarget = join(dirFixture.workspace, 'folder')
    mkdirSync(dirTarget)
    record(dirFixture, '旧内容\n', '新内容\n', { targetPath: dirTarget })
    const dirOutcome = restoreSnapshotSafely({
      snapshotRoot: dirFixture.sessionRoot,
      snapshotPath: dirFixture.snapshotPath,
      targetPath: dirTarget,
      workspace: dirFixture.workspace
    })
    expect(dirOutcome.ok).toBe(false)
    if (!dirOutcome.ok) expect(dirOutcome.code).toBe('UNDO_CONFLICT')
  })
})
