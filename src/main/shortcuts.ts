import { globalShortcut } from 'electron'
import { toElectronAccelerator } from '../shared/shortcuts'
import { getSettingsStore } from './settings'
import { toggleIsland } from './runtime'
import { log } from './logger'

let activeAccelerator: string | null = null

export interface GlobalShortcutStatus {
  available: boolean
  accelerator: string
  reason?: string
}

function isTestMode(): boolean {
  return process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')
}

/**
 * 重新注册桌面伙伴的全局快捷键。
 * 设置保存前会调用；注册失败时由 IPC 回滚设置并给出原因，避免界面显示成功但实际不生效。
 */
export function refreshGlobalShortcut(): GlobalShortcutStatus {
  const binding = getSettingsStore().get().shortcuts.island
  const accelerator = toElectronAccelerator(binding)
  if (activeAccelerator) {
    try {
      globalShortcut.unregister(activeAccelerator)
    } catch {
      // 旧注册已失效时忽略
    }
    activeAccelerator = null
  }
  if (isTestMode()) {
    return { available: true, accelerator, reason: '测试模式不注册系统级快捷键' }
  }
  try {
    const ok = globalShortcut.register(accelerator, () => toggleIsland())
    if (!ok) {
      log.warn('global shortcut is already taken', { accelerator })
      return { available: false, accelerator, reason: `${accelerator} 已被系统或其他应用占用。` }
    }
    activeAccelerator = accelerator
    log.info('global shortcut registered', { accelerator })
    return { available: true, accelerator }
  } catch (err) {
    log.warn('global shortcut registration failed', { accelerator, error: String(err) })
    return { available: false, accelerator, reason: `无法注册 ${accelerator}，换一个组合试试。` }
  }
}

export function disposeGlobalShortcut(): void {
  if (activeAccelerator) {
    try {
      globalShortcut.unregister(activeAccelerator)
    } catch {
      // 退出时忽略
    }
    activeAccelerator = null
  }
}
