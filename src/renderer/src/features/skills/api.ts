/**
 * 技能库 IPC 客户端：统一走 window.morrow.features.invoke（feature:skills:*），
 * 把 Result<T> 解包成 T / throw Error，供面板使用。
 */
import type {
  InstallResult,
  SkillDetail,
  SkillsPathResult,
  SkillsPickResult,
  SkillsSnapshot
} from './types'

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result = await window.morrow.features.invoke<T>(channel, payload)
  if (!result.ok) {
    const error = new Error(result.error.message || '技能库操作失败')
    error.name = result.error.code
    throw error
  }
  return result.data
}

export const skillsApi = {
  list: (workspace: string | null): Promise<SkillsSnapshot> => invoke('feature:skills:list', { workspace }),
  read: (id: string, workspace: string | null): Promise<SkillDetail> => invoke('feature:skills:read', { id, workspace }),
  setEnabled: (id: string, enabled: boolean, workspace: string | null): Promise<SkillsSnapshot> =>
    invoke('feature:skills:setEnabled', { id, enabled, workspace }),
  install: (sourcePath: string, workspace: string | null, overwrite = false): Promise<InstallResult> =>
    invoke('feature:skills:install', { sourcePath, workspace, overwrite }),
  remove: (id: string, workspace: string | null): Promise<SkillsSnapshot> =>
    invoke('feature:skills:remove', { id, workspace }),
  rescan: (workspace: string | null): Promise<SkillsSnapshot> => invoke('feature:skills:rescan', { workspace }),
  reveal: (id: string, workspace: string | null): Promise<SkillsPathResult> =>
    invoke('feature:skills:reveal', { id, workspace }),
  openUserDir: (): Promise<SkillsPathResult> => invoke('feature:skills:openUserDir', {}),
  pickZip: (): Promise<SkillsPickResult> => invoke('feature:skills:pickZip', {}),
  pickFolder: (): Promise<SkillsPickResult> => invoke('feature:skills:pickFolder', {})
}
