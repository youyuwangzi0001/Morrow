/**
 * 工作区路径与文件事件：渲染层里跨组件复用、又不属于任何单个功能域的纯工具。
 *
 * 放在 `components.tsx` 会与 feature 形成互相 import 的环（组件要用路径工具，
 * feature 要用按钮组件）；因此单独成文件，两边都只往下依赖它。
 */
export interface OpenFileDetail {
  path: string
  absolutePath: string
}

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

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

/** 工作区相对 → 绝对（Windows 盘符/分隔符都兼容） */
export function joinWorkspacePath(workspace: string, relative: string): string {
  const base = workspace.replace(/[\\/]+$/, '')
  const rel = normalizeRelativePath(relative)
  const sep = base.includes('\\') ? '\\' : '/'
  return `${base}${sep}${rel.replace(/\//g, sep)}`
}

/** 绝对 → 工作区相对；不在工作区内返回 null */
export function relativeToWorkspace(workspace: string | null | undefined, absolutePath: string): string | null {
  if (!workspace) return null
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const base = norm(workspace)
  const target = norm(absolutePath)
  if (target === base) return ''
  if (!target.startsWith(`${base}/`)) return null
  const relative = absolutePath.replace(/\\/g, '/').slice(workspace.replace(/\\/g, '/').replace(/\/+$/, '').length + 1)
  return normalizeRelativePath(relative)
}
