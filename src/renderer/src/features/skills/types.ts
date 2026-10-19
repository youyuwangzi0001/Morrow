/**
 * R10-H 技能库面板的渲染层类型（与主进程 skills-service 返回的纯数据一致）。
 * 渲染层不 import 主进程代码，避免把 Node/electron 依赖带进 renderer 包。
 */

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
}

export interface SkillsPickResult {
  path: string | null
}

export interface SkillsPathResult {
  path: string
}

export type SkillFilter = 'all' | 'enabled' | 'disabled'
export type SkillSort = 'name' | 'updated'
