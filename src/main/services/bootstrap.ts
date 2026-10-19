import { app } from 'electron'
import type { AppInfo, Bootstrap, Project } from '../../shared/types'
import { getSettingsStore } from './settings-store'
import { getSessionStore } from './session-store'
import { recoverGoalsOnStartup } from './goal-recovery'
import { describeWorkspace } from './workspace'

/** 启动数据：设置 + 会话元信息 + 项目列表 + 应用信息 */
export async function createBootstrap(): Promise<Bootstrap> {
  const settingsStore = getSettingsStore()
  const sessionStore = getSessionStore()
  const settings = settingsStore.get()
  if (process.argv.includes('--skip-onboarding')) {
    settings.onboardingDone = true
  }
  // R7 审计：重启后 active 目标转为可恢复的 paused（保留轮次与预算计数，绝不算完成）
  recoverGoalsOnStartup(sessionStore)
  const sessions = sessionStore.list()

  const projectMap = new Map<string, Project>()
  for (const workspace of settings.recentWorkspaces) {
    try {
      const info = describeWorkspace(workspace)
      if (!info.exists) continue
      projectMap.set(info.path, {
        id: info.path,
        name: info.name,
        path: info.path,
        lastOpenedAt: 0
      })
    } catch {
      // 忽略失效目录
    }
  }
  for (const session of sessions) {
    if (!session.workspace) continue
    const existing = projectMap.get(session.workspace)
    const stamp = session.updatedAt
    if (!existing) {
      const name = session.workspace.split(/[\\/]/).filter(Boolean).pop() ?? session.workspace
      projectMap.set(session.workspace, { id: session.workspace, name, path: session.workspace, lastOpenedAt: stamp })
    } else if (stamp > existing.lastOpenedAt) {
      projectMap.set(session.workspace, { ...existing, lastOpenedAt: stamp })
    }
  }
  const projects = [...projectMap.values()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)

  const info: AppInfo = {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform as AppInfo['platform'],
    dataDir: app.getPath('userData'),
    buildTime: process.env.MORROW_BUILD_TIME,
    buildSha: process.env.MORROW_BUILD_SHA
  }

  return {
    settings,
    sessions,
    projects,
    app: info,
    demoAvailable: true,
    hasAnyApiKey: settingsStore.hasAnyApiKey()
  }
}
