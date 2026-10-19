/**
 * 「撤销一次文件修改」的安全实现（R7 审计修复）。
 *
 * 旧实现（main/ipc.ts）按快照直接写回，会静默覆盖用户在写入之后手工做的修改。
 * 新规则：
 * - 每次写/编辑时 fs-tools 会在快照目录写 `.restore.json`（targetPath / beforeHash / afterHash）；
 * - 撤销前先算目标文件当前哈希：
 *   - 等于 afterHash → 没有被改过，可以安全恢复；
 *   - 等于 beforeHash → 已经是旧内容（重复撤销），幂等返回成功；
 *   - 两者都不是 → 返回 UNDO_CONFLICT，拒绝覆盖；
 *   - 文件不存在 → 允许恢复（没有可被覆盖的手工修改）；
 *   - 缺少清单且文件存在 → 无法证明是否被改过，拒绝并提示。
 * 本模块不 import electron，可直接在 Node 单测/审计中验证。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { inspectWorkspacePath } from '@core/tools/paths'
import { sha256 } from '@core/util'

export const RESTORE_MANIFEST_FILE = '.restore.json'

export interface RestoreSnapshotInput {
  /** 快照根目录（通常是 userData/snapshots） */
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

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`))
}

function readManifest(snapshotPath: string): RestoreManifest | null {
  const file = join(dirname(snapshotPath), RESTORE_MANIFEST_FILE)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RestoreManifest
  } catch {
    return null
  }
}

/** 原子写回（避免打断时留下半个文件） */
function atomicWrite(target: string, content: Buffer): void {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.restore.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, target)
}

export function restoreSnapshotSafely(input: RestoreSnapshotInput): RestoreSnapshotOutcome {
  try {
    const snapshotRoot = resolve(input.snapshotRoot)
    const snapshot = resolve(input.snapshotPath)
    const target = resolve(input.targetPath)
    if (!isInside(snapshot, snapshotRoot) || snapshot === snapshotRoot) {
      return fail('INVALID_SNAPSHOT', '快照路径不合法。')
    }
    if (!existsSync(snapshot)) return fail('SNAPSHOT_MISSING', '这个快照已经不存在了。')
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
    const targetReal = resolvedTarget.real

    const manifest = readManifest(snapshot)
    const currentExists = existsSync(targetReal)
    const currentHash = currentExists ? sha256(readFileSync(targetReal)) : null

    if (currentExists) {
      if (!manifest || typeof manifest.afterHash !== 'string') {
        return fail(
          'UNDO_UNVERIFIABLE',
          '无法确认这个文件在修改后有没有被手工改过，已拒绝自动覆盖。',
          '可以先把当前文件另存一份，或从备份中手动恢复。'
        )
      }
      if (manifest.targetPath && resolve(manifest.targetPath) !== target) {
        return fail('UNDO_CONFLICT', '快照记录的目标文件与要恢复的文件不一致，已拒绝。')
      }
      if (currentHash !== manifest.afterHash) {
        if (typeof manifest.beforeHash === 'string' && currentHash === manifest.beforeHash) {
          return { ok: true, written: false, message: '文件已经是修改前的内容，无需再次撤销。' }
        }
        return fail(
          'UNDO_CONFLICT',
          '文件在 Morrow 修改之后又被改过，撤销会覆盖这些新改动，已拒绝。',
          '可以先把当前文件另存一份，再手动恢复快照内容。'
        )
      }
    }

    atomicWrite(targetReal, readFileSync(snapshot))
    return { ok: true, written: true, message: '已恢复到这次修改之前的内容。' }
  } catch (err) {
    return fail('RESTORE_FAILED', `恢复文件失败：${err instanceof Error ? err.message : String(err)}`)
  }
}
