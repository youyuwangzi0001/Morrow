/**
 * R10-A 文件功能模块：注册 feature:files:* 频道（Lead 只需在 features/index.ts import 本文件）。
 *
 * 频道：
 * - feature:files:list       { workspace?, dir?, showHidden? } → { workspace, dir, entries, limited, readOnly }
 * - feature:files:read       { path, workspace?, maxBytes? } → { path, content, size, mtimeMs, encoding, workspace, readOnly }
 * - feature:files:stat       { path, workspace? } → { path, size, mtimeMs, kind, workspace }
 * - feature:files:write      { path, content, expectedMtimeMs?, workspace? } → { path, size, mtimeMs, created, snapshot? }
 * - feature:files:create     { path, kind: 'file'|'dir', workspace? } → WorkspaceFileEntry
 * - feature:files:rename     { from, to, workspace? } → { from, to, kind }
 * - feature:files:move       { from, toDir, workspace? } → { from, to, kind }
 * - feature:files:delete     { path, recursive?, confirm:true, workspace? } → { deleted, path, kind }
 * - feature:files:inspect    { path, workspace? } → WorkspaceFileEntry & { childCount? }
 * - feature:files:reveal     { path, workspace? } → { ok: true }
 * - feature:files:attachPath { path, workspace? } → Attachment
 * - feature:files:startDrag  { path, workspace? } → { ok: true }（原生拖拽，可直接拖进 Composer）
 *
 * 安全：边界/symlink/大小/二进制/原子写/快照/mtime 冲突都在 services/workspace-files 里；
 * 本模块额外做：只读全局拦截、缺失 workspace 时的安全回退、startDrag 只允许普通文件。
 */
import { app, nativeImage, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { registerFeatureHandler } from '../feature-ipc'
import { dataPath } from '../services/paths'
import { getSettingsStore } from '../services/settings-store'
import { getSessionStore } from '../services/session-store'
import {
  WorkspaceFileError,
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  findWorkspaceContaining,
  inspectWorkspaceEntry,
  listWorkspaceEntries,
  moveWorkspaceEntry,
  readWorkspaceFile,
  renameWorkspaceEntry,
  statWorkspaceFile,
  workspaceAttachment,
  writeWorkspaceFile
} from '../services/workspace-files'
import { log } from '../services/logger'

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
    // ignore
  }
  try {
    const sessions = getSessionStore().list()
    const ordered = sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)
    for (const session of ordered) {
      if (session.workspace) list.push(session.workspace)
    }
  } catch {
    // ignore
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
  if (explicit) return resolve(explicit)
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
      // ignore
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

registerFeatureHandler('feature:files:reveal', (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  const stat = statWorkspaceFile(workspace, text(input.path))
  shell.showItemInFolder(stat.absolutePath)
  return { ok: true, path: stat.path }
})

registerFeatureHandler('feature:files:attachPath', (payload) => {
  const input = payloadOf(payload)
  const workspace = resolveWorkspaceFromPayload(input)
  return workspaceAttachment(workspace, text(input.path))
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
    throw new WorkspaceFileError('DRAG_FAILED', '启动拖拽失败，可以改用右键「添加到对话」。')
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
