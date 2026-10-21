import type { Settings } from '@shared/types'

/** 明暗主题与减少动效：主窗口、灵动岛等独立窗口共用同一套应用方式。 */
export function applyThemePreferences(settings: Pick<Settings, 'theme' | 'reduceMotion'>): void {
  const root = document.documentElement
  root.dataset.theme = settings.theme
  root.dataset.reduceMotion = settings.reduceMotion ? 'true' : 'false'
}
