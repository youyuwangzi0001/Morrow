// workbench 功能域逻辑：由 1 个 TS 文件扁平合并。

export type WorkbenchPanel =
  | 'skills'
  | 'memory'
  | 'projects'
  | 'schedules'
  | 'connectors'
  | 'search'
  | 'browser'
  | 'terminal'
  | 'git'

export const WORKBENCH_EVENT = 'morrow:workbench'

export interface WorkbenchOpenOptions {
  /** 让面板直接聚焦某个工作区（项目主页跳转「管理资料」用） */
  workspace?: string
  /** 项目面板的默认视图：概览或说明与资料 */
  view?: 'home' | 'settings'
}

export function openWorkbench(panel?: WorkbenchPanel, options: WorkbenchOpenOptions = {}): void {
  window.dispatchEvent(
    new CustomEvent(WORKBENCH_EVENT, {
      detail: {
        ...(panel ? { panel } : {}),
        ...(options.workspace ? { workspace: options.workspace } : {}),
        ...(options.view ? { view: options.view } : {})
      }
    })
  )
}

export function parseWorkbenchPanel(value: unknown): WorkbenchPanel | null {
  return value === 'skills' ||
    value === 'memory' ||
    value === 'projects' ||
    value === 'schedules' ||
    value === 'connectors' ||
    value === 'search' ||
    value === 'browser' ||
    value === 'terminal' ||
    value === 'git'
    ? value
    : null
}
