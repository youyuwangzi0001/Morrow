// R10-H 技能库面板的渲染层类型与 IPC 客户端（与主进程 skills-service 返回的纯数据一致）。

export interface SkillFileEntry {
  /** 相对技能目录的路径（/ 分隔） */
  path: string
  size: number
}

export interface SkillView {
  id: string
  name: string
  description: string
  source: 'workspace' | 'user'
  builtin: boolean
  enabled: boolean
  dir: string
  skillPath: string
  displayDir: string
  declaredName?: string
  installedAt: number | null
  updatedAt: number
  fileCount: number
  sizeBytes: number
  resources: string[]
  /** 用户技能被同名工作区技能覆盖（Agent 实际用工作区那份） */
  shadowed: boolean
  valid: boolean
  error?: string
}

export interface SkillDetail extends SkillView {
  raw: string
  rawTruncated: boolean
  files: SkillFileEntry[]
}

export interface SkillsSnapshot {
  userDir: string
  stateFile: string
  workspace: string | null
  skills: SkillView[]
  errors: string[]
  scannedAt: number
}

export interface InstallResult {
  installed: SkillView
  snapshot: SkillsSnapshot
  skipped: string[]
}

export interface SkillsPickResult {
  path: string | null
}

export interface SkillsPathResult {
  path: string
}

export type SkillFilter = 'all' | 'enabled' | 'disabled'
export type SkillSort = 'name' | 'updated'

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
