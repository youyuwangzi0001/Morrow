// 设置弹窗的「打开到指定 Tab」请求通道。
export type SettingsTabId =
  | 'models'
  | 'subscriptions'
  | 'media'
  | 'search'
  | 'context'
  | 'style'
  | 'usage'
  | 'archive'
  | 'permission'
  | 'automation'
  | 'tools'
  | 'terminal'
  | 'appearance'
  | 'shortcuts'
  | 'about'

let pendingTab: SettingsTabId | null = null
const listeners = new Set<(tab: SettingsTabId) => void>()

export function requestSettingsTab(tab: SettingsTabId): void {
  pendingTab = tab
  for (const listener of listeners) listener(tab)
}

export function consumeRequestedTab(): SettingsTabId | null {
  const tab = pendingTab
  pendingTab = null
  return tab
}

export function onSettingsTabRequest(listener: (tab: SettingsTabId) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
