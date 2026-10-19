export type WorkbenchPanel = 'skills' | 'memory' | 'projects' | 'connectors' | 'search' | 'browser'

export const WORKBENCH_EVENT = 'morrow:workbench'

export function openWorkbench(panel?: WorkbenchPanel): void {
  window.dispatchEvent(new CustomEvent(WORKBENCH_EVENT, { detail: panel ? { panel } : {} }))
}

export function parseWorkbenchPanel(value: unknown): WorkbenchPanel | null {
  return value === 'skills' ||
    value === 'memory' ||
    value === 'projects' ||
    value === 'connectors' ||
    value === 'search' ||
    value === 'browser'
    ? value
    : null
}
