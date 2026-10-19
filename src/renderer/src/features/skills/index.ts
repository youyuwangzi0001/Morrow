/**
 * R10-H 技能库面板（独立受控组件）。
 *
 * 挂载方式（Lead）：`<SkillsPanel open={skillsOpen} onClose={() => setSkillsOpen(false)} />`；
 * 本模块不修改 App/Settings/Sidebar/store，依赖全局 tokens 与 ui 组件。
 */
export { SkillsPanel, type SkillsPanelProps } from './SkillsPanel'
export { skillsApi } from './api'
export type {
  InstallResult,
  SkillDetail,
  SkillFileEntry,
  SkillFilter,
  SkillsSnapshot,
  SkillSort,
  SkillView
} from './types'
