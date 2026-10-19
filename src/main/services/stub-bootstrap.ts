import { app } from 'electron'
import { defaultSettings } from '../../shared/models'
import type { Bootstrap } from '../../shared/types'

/**
 * M0 临时实现：只返回安全的默认值，用于点亮窗口骨架。
 * M1 集成阶段由真实的 SettingsStore / SessionStore 取代（见 main/ipc.ts）。
 */
export async function createStubBootstrap(): Promise<Bootstrap> {
  return {
    settings: defaultSettings(),
    sessions: [],
    projects: [],
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform as Bootstrap['app']['platform'],
      dataDir: app.getPath('userData')
    },
    demoAvailable: true,
    hasAnyApiKey: false
  }
}
