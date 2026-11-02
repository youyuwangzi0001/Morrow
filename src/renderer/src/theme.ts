import type { Settings } from '@shared/types'

/** 明暗主题、减少动效与代码字体：主窗口、灵动岛等独立窗口共用同一套应用方式。 */
export function applyThemePreferences(
  settings: Pick<Settings, 'theme' | 'reduceMotion'> & Partial<Pick<Settings, 'codeFont'>>
): void {
  const root = document.documentElement
  root.dataset.theme = settings.theme
  root.dataset.reduceMotion = settings.reduceMotion ? 'true' : 'false'
  root.dataset.codeFont = settings.codeFont ?? 'jetbrains'
  // 窗口/任务栏/托盘图标跟随主题；独立窗口没有该 API 时静默跳过
  void window.morrow?.app?.setTheme?.(settings.theme)
}
