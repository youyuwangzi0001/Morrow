/**
 * feature IPC 共用的工作区边界：只允许操作已登记工作区内真实存在的目录。
 * 终端、Git 工作台都经过同一份路径判定。
 */
import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { isPathInside } from '../services/paths'
import { getSettingsStore } from '../services/settings-store'
import { getSessionStore } from '../services/session-store'

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
