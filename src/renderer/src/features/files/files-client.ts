/**
 * R10-A 文件 API 客户端：所有调用统一走 window.morrow.features.invoke('feature:files:*')。
 * payload 里的 workspace 始终显式传入（主进程也支持缺省回退，但显式更安全）。
 */
import { useAppStore } from '../../state/store'

export type EntryKind = 'file' | 'dir' | 'symlink'

export interface FileEntry {
  name: string
  /** 工作区相对路径（posix 分隔；根目录为 ''） */
  path: string
  kind: EntryKind
  size: number
  mtimeMs: number
  isSymlink: boolean
  restricted?: boolean
}

export interface FileListResult {
  workspace: string
  dir: string
  entries: FileEntry[]
  limited: boolean
  readOnly: boolean
}

export interface FileReadResult {
  path: string
  absolutePath: string
  content: string
  size: number
  mtimeMs: number
  encoding: 'utf8'
  workspace: string
  readOnly: boolean
}

export interface FileStatResult {
  path: string
  absolutePath: string
  kind: 'file' | 'dir'
  size: number
  mtimeMs: number
  workspace: string
  readOnly: boolean
}

export interface FileWriteResult {
  path: string
  absolutePath: string
  size: number
  mtimeMs: number
  created: boolean
  snapshot?: string
  workspace: string
}

export interface FileInspectResult extends FileEntry {
  childCount?: number
  workspace?: string
}

export class FileApiError extends Error {
  code: string

  constructor(message: string, code = 'FILES_ERROR') {
    super(message)
    this.name = 'FileApiError'
    this.code = code
  }
}

async function invoke<T>(channel: string, payload: Record<string, unknown>): Promise<T> {
  const result = await window.morrow.features.invoke<T>(channel, payload)
  if (!result.ok) throw new FileApiError(result.error.message, result.error.code)
  return result.data
}

/** 当前会话/设置对应的工作区（文件树与编辑器打开文件都用它） */
export function currentWorkspace(): string | null {
  const state = useAppStore.getState()
  return state.session?.workspace ?? state.settings.lastWorkspace ?? null
}

function withWorkspace(payload: Record<string, unknown>, workspace?: string | null): Record<string, unknown> {
  const root = workspace ?? currentWorkspace()
  if (!root) throw new FileApiError('还没有选择工作文件夹。', 'NO_WORKSPACE')
  return { ...payload, workspace: root }
}

export const filesApi = {
  list(workspace: string, dir: string, showHidden: boolean): Promise<FileListResult> {
    return invoke<FileListResult>('feature:files:list', withWorkspace({ dir, showHidden }, workspace))
  },

  read(path: string, workspace?: string | null): Promise<FileReadResult> {
    return invoke<FileReadResult>('feature:files:read', withWorkspace({ path }, workspace))
  },

  stat(path: string, workspace?: string | null): Promise<FileStatResult> {
    return invoke<FileStatResult>('feature:files:stat', withWorkspace({ path }, workspace))
  },

  write(
    path: string,
    content: string,
    options: { workspace?: string | null; expectedMtimeMs?: number | null } = {}
  ): Promise<FileWriteResult> {
    return invoke<FileWriteResult>(
      'feature:files:write',
      withWorkspace(
        {
          path,
          content,
          ...(options.expectedMtimeMs === undefined ? {} : { expectedMtimeMs: options.expectedMtimeMs })
        },
        options.workspace
      )
    )
  },

  create(path: string, kind: 'file' | 'dir', workspace?: string | null): Promise<FileEntry> {
    return invoke<FileEntry>('feature:files:create', withWorkspace({ path, kind }, workspace))
  },

  rename(from: string, to: string, workspace?: string | null): Promise<{ from: string; to: string; kind: string }> {
    return invoke('feature:files:rename', withWorkspace({ from, to }, workspace))
  },

  move(from: string, toDir: string, workspace?: string | null): Promise<{ from: string; to: string; kind: string }> {
    return invoke('feature:files:move', withWorkspace({ from, toDir }, workspace))
  },

  remove(
    path: string,
    options: { recursive?: boolean; workspace?: string | null } = {}
  ): Promise<{ deleted: true; path: string; kind: string }> {
    return invoke(
      'feature:files:delete',
      withWorkspace({ path, recursive: options.recursive === true, confirm: true }, options.workspace)
    )
  },

  inspect(path: string, workspace?: string | null): Promise<FileInspectResult> {
    return invoke<FileInspectResult>('feature:files:inspect', withWorkspace({ path }, workspace))
  },

  reveal(path: string, workspace?: string | null): Promise<{ ok: true }> {
    return invoke('feature:files:reveal', withWorkspace({ path }, workspace))
  },

  /** 原生拖拽：让文件树里的文件能拖进 Composer / 资源管理器 */
  startDrag(path: string, workspace?: string | null): Promise<{ ok: true }> {
    return invoke('feature:files:startDrag', withWorkspace({ path }, workspace))
  }
}

/** 工作区相对路径 → 绝对路径（派发 morrow:open-file 时附带，方便编辑器判断） */
export function toAbsolutePath(workspace: string, path: string): string {
  const normalized = workspace.replace(/[\\/]+$/, '')
  return `${normalized}\\${path.split('/').join('\\')}`
}

export interface OpenFileDetail {
  path: string
  absolutePath: string
}

/** 点击文件时通知编辑器（surfaces）打开 */
export function dispatchOpenFile(detail: OpenFileDetail): void {
  window.dispatchEvent(new CustomEvent<OpenFileDetail>('morrow:open-file', { detail }))
}

export interface FileRenamedDetail {
  from: string
  to: string
  isDir: boolean
}

export interface FileDeletedDetail {
  path: string
  isDir: boolean
}

/** 文件/目录改名后通知编辑器同步已打开标签 */
export function dispatchFileRenamed(detail: FileRenamedDetail): void {
  window.dispatchEvent(new CustomEvent<FileRenamedDetail>('morrow:file-renamed', { detail }))
}

/** 文件/目录删除后通知编辑器关闭/标记已打开标签 */
export function dispatchFileDeleted(detail: FileDeletedDetail): void {
  window.dispatchEvent(new CustomEvent<FileDeletedDetail>('morrow:file-deleted', { detail }))
}

/** 编辑器保存/另存为后通知文件树刷新 */
export function dispatchFilesChanged(): void {
  window.dispatchEvent(new CustomEvent('morrow:files-changed'))
}
