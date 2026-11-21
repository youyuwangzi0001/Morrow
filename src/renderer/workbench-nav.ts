/**
 * 工作台导航的跨域契约：打开哪个面板、从哪里跳进来。
 *
 * 这几个函数被侧栏、输入框、记忆页与设置页共用。放在 `features/workbench.tsx`
 * 会迫使 `memory.tsx` 反向依赖工作台组件，形成「工作台 → 记忆页 → 工作台」的环；
 * 单独成文件后，两边都只依赖这一层。
 */
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
export const CLOSE_BROWSER_EVENT = 'morrow:close-browser'

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
