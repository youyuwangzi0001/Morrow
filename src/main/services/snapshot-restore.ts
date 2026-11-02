/**
 * 「撤销一次文件修改」的安全实现（R7 / R11 审计修复）。
 *
 * 每次写/编辑时 fs-tools 会在快照目录写 `.restore.json`（targetPath / beforeHash / afterHash）；
 * 撤销前必须同时证明三件事：
 * - 快照确实属于当前会话的 `<snapshotRoot>/<toolUseId>/<filename>`（防跨会话/跨盘读取）；
 * - 快照内容与清单里的 beforeHash 一致（防备份被替换）；
 * - 目标文件当前内容等于 afterHash（没有被手工改过）或 beforeHash（重复撤销，幂等）。
 *
 * 目标文件不存在时也要求清单与目标一致，避免把任意快照复制到任意工作区路径。
 * 本模块不 import electron，可直接在 Node 单测/审计中验证。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inspectWorkspacePath } from '@core/tools/paths'

export const RESTORE_MANIFEST_FILE = '.restore.json'

export interface RestoreSnapshotInput {
  /** 当前会话的快照根目录（<userData>/snapshots/<sessionId>） */
  snapshotRoot: string
  /** 写前备份文件路径（<snapshotRoot>/<toolUseId>/<filename>） */
  snapshotPath: string
  /** 要恢复的目标文件 */
  targetPath: string
  /** 会话工作区（恢复目标必须在其内部） */
  workspace: string | null
}

export type RestoreSnapshotOutcome =
  | { ok: true; written: boolean; message: string }
  | {
      ok: false
      code:
        | 'INVALID_SNAPSHOT'
        | 'SNAPSHOT_MISSING'
        | 'NO_WORKSPACE'
        | 'OUTSIDE_WORKSPACE'
        | 'UNDO_CONFLICT'
        | 'UNDO_UNVERIFIABLE'
        | 'RESTORE_FAILED'
      message: string
      hint?: string
    }

interface RestoreManifest {
  targetPath?: string
  beforeHash?: string | null
  afterHash?: string
}

function fail(
  code: Extract<RestoreSnapshotOutcome, { ok: false }>['code'],
  message: string,
  hint?: string
): RestoreSnapshotOutcome {
  return { ok: false, code, message, ...(hint ? { hint } : {}) }
}

/** 严格判断 child 是否在 parent 内（跨盘 relative 返回绝对路径，必须拒绝） */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function samePath(a: string, b: string): boolean {
  const fold = (value: string): string => {
    const absolute = resolve(value)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  return fold(a) === fold(b)
}

function hashFileSync(path: string): string {
  const fd = openSync(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let position = 0
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
      position += read
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function readManifest(snapshotPath: string): RestoreManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dirname(snapshotPath), RESTORE_MANIFEST_FILE), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record.targetPath === 'string' ? { targetPath: record.targetPath } : {}),
      ...(typeof record.beforeHash === 'string' || record.beforeHash === null ? { beforeHash: record.beforeHash } : {}),
      ...(typeof record.afterHash === 'string' ? { afterHash: record.afterHash } : {})
    }
  } catch {
    return null
  }
}

/** 原子复制（避免打断时留下半个文件；不把整个快照读进内存） */
function atomicCopy(target: string, source: string): void {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.restore.tmp`
  try {
    copyFileSync(source, tmp)
    renameSync(tmp, target)
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理失败不影响结果
    }
  }
}

export function restoreSnapshotSafely(input: RestoreSnapshotInput): RestoreSnapshotOutcome {
  try {
    const snapshotRoot = resolve(input.snapshotRoot)
    const snapshot = resolve(input.snapshotPath)
    if (!isInside(snapshot, snapshotRoot)) {
      return fail('INVALID_SNAPSHOT', '快照路径不合法。')
    }

    let rootReal: string
    let snapshotReal: string
    try {
      rootReal = realpathSync(snapshotRoot)
      snapshotReal = realpathSync(snapshot)
    } catch {
      return fail('SNAPSHOT_MISSING', '这个快照已经不存在了。')
    }
    if (!isInside(snapshotReal, rootReal)) {
      return fail('INVALID_SNAPSHOT', '快照路径不合法。')
    }
    // 只接受 <toolUseId>/<filename> 两层；不能把 .restore.json 或更深层文件当备份恢复
    const relativeSnapshot = relative(rootReal, snapshotReal)
    const parts = relativeSnapshot.split(sep)
    if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1] === RESTORE_MANIFEST_FILE) {
      return fail('INVALID_SNAPSHOT', '快照路径不合法。')
    }
    let snapshotStat
    try {
      snapshotStat = statSync(snapshotReal)
    } catch {
      return fail('SNAPSHOT_MISSING', '这个快照已经不存在了。')
    }
    if (!snapshotStat.isFile()) return fail('INVALID_SNAPSHOT', '快照不是普通文件。')

    if (!input.workspace) return fail('NO_WORKSPACE', '这个对话没有绑定工作区，不能恢复文件。')
    // 用与工具一致的 realpath 沙箱判断目标是否真的在工作区内（防符号链接越界）
    let resolvedTarget: ReturnType<typeof inspectWorkspacePath>
    try {
      resolvedTarget = inspectWorkspacePath(input.targetPath, input.workspace)
    } catch {
      return fail('OUTSIDE_WORKSPACE', '要恢复的文件不在工作区内，已拒绝。')
    }
    if (!resolvedTarget.inside) {
      return fail('OUTSIDE_WORKSPACE', '要恢复的文件不在工作区内，已拒绝。')
    }
    const target = resolvedTarget.absolute
    const targetReal = resolvedTarget.real

    const manifest = readManifest(snapshotReal)
    if (
      !manifest ||
      typeof manifest.targetPath !== 'string' ||
      typeof manifest.afterHash !== 'string' ||
      typeof manifest.beforeHash !== 'string'
    ) {
      return fail(
        'UNDO_UNVERIFIABLE',
        '无法确认这个快照对应哪次修改，已拒绝自动覆盖。',
        '可以先把当前文件另存一份，或从备份中手动恢复。'
      )
    }
    if (!samePath(manifest.targetPath, target)) {
      return fail('UNDO_CONFLICT', '快照记录的目标文件与要恢复的文件不一致，已拒绝。')
    }
    // 备份内容必须与清单记录一致，防止快照文件被替换后当成别的版本恢复
    if (hashFileSync(snapshotReal) !== manifest.beforeHash) {
      return fail('UNDO_UNVERIFIABLE', '备份内容与撤销记录不一致，已拒绝自动覆盖。')
    }

    let currentExists = false
    try {
      const current = statSync(targetReal)
      if (!current.isFile()) {
        return fail('UNDO_CONFLICT', '要恢复的目标不是普通文件，已拒绝。')
      }
      currentExists = true
    } catch {
      currentExists = false
    }
    const currentHash = currentExists ? hashFileSync(targetReal) : null

    if (currentExists) {
      if (currentHash !== manifest.afterHash) {
        if (currentHash === manifest.beforeHash) {
          return { ok: true, written: false, message: '文件已经是修改前的内容，无需再次撤销。' }
        }
        return fail(
          'UNDO_CONFLICT',
          '文件在 Morrow 修改之后又被改过，撤销会覆盖这些新改动，已拒绝。',
          '可以先把当前文件另存一份，再手动恢复快照内容。'
        )
      }
    }

    atomicCopy(targetReal, snapshotReal)
    return { ok: true, written: true, message: '已恢复到这次修改之前的内容。' }
  } catch (err) {
    return fail('RESTORE_FAILED', `恢复文件失败：${err instanceof Error ? err.message : String(err)}`)
  }
}
