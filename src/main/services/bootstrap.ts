import { app } from 'electron'
import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AppInfo, Bootstrap, Project } from '../../shared/types'
import { getSettingsStore } from './settings-store'
import { getSessionStore } from './session-store'
import { describeWorkspace } from './workspace'
import { dataDirInfo, dataPath } from './paths'
import { log } from './logger'

const APP_RESTART_NOTE =
  '应用重启前目标正在运行，已自动暂停；轮次与预算计数已保留，可从目标条「继续」接着做。'

let goalsRecoveredThisProcess = false

/** 重启后把 active 目标转为可恢复的 paused；保留轮次、摘要与预算计数。 */
function recoverGoalsOnStartup(sessionStore: ReturnType<typeof getSessionStore>): number {
  if (goalsRecoveredThisProcess) return 0
  goalsRecoveredThisProcess = true
  let count = 0
  for (const meta of sessionStore.list()) {
    const session = sessionStore.get(meta.id)
    const goal = session?.goal
    if (!session || !goal || goal.status !== 'active') continue
    goal.status = 'paused'
    goal.stopReason = 'app_restarted'
    goal.updatedAt = Date.now()
    goal.summary = goal.summary?.trim() ? `${goal.summary.trim()}\n（${APP_RESTART_NOTE}）` : APP_RESTART_NOTE
    sessionStore.save(session)
    count += 1
  }
  if (count > 0) log.info('active goals recovered as paused after restart', { count })
  return count
}

/** 应用关闭时研究轮次无法继续：重启后如实标记为停止，用户可继续发消息。 */
function recoverResearchOnStartup(sessionStore: ReturnType<typeof getSessionStore>): void {
  for (const meta of sessionStore.list()) {
    if (meta.research?.status !== 'searching' && meta.research?.status !== 'planning') continue
    const session = sessionStore.get(meta.id)
    if (!session?.research) continue
    const wasPlanning = session.research.status === 'planning'
    session.research = {
      ...session.research,
      status: 'stopped',
      gap: wasPlanning
        ? 'Morrow 上次在制定研究计划时退出了；可以重新发送研究问题。'
        : 'Morrow 上次在研究时退出了；可以继续发送消息接着研究。',
      updatedAt: Date.now()
    }
    sessionStore.save(session)
  }
}

/**
 * 临时对话只在内存中，正常退出时随进程消失；崩溃/强杀可能留下它的撤销快照、
 * 检查点或成品版本目录。启动时按 tmp_ 前缀清掉这些内部痕迹。
 */
function cleanupTemporarySessionData(): void {
  for (const name of ['snapshots', 'checkpoints', 'artifact-versions']) {
    const dir = dataPath(name)
    if (!existsSync(dir)) continue
    try {
      for (const entry of readdirSync(dir)) {
        if (!entry.startsWith('tmp_')) continue
        rmSync(join(dir, entry), { recursive: true, force: true })
      }
    } catch {
      // 清理失败不影响启动；下次启动还会再试
    }
  }
  const sessionsDir = dataPath('sessions')
  if (!existsSync(sessionsDir)) return
  try {
    for (const entry of readdirSync(sessionsDir)) {
      if (entry.startsWith('tmp_') && entry.endsWith('.json')) {
        unlinkSync(join(sessionsDir, entry))
      }
    }
  } catch {
  }
}

/** 启动数据：设置 + 会话元信息 + 项目列表 + 应用信息 */
export async function createBootstrap(): Promise<Bootstrap> {
  cleanupTemporarySessionData()
  const settingsStore = getSettingsStore()
  const sessionStore = getSessionStore()
  const settings = settingsStore.get()
  if (process.argv.includes('--skip-onboarding')) {
    settings.onboardingDone = true
  }
  // R7 审计：重启后 active 目标转为可恢复的 paused（保留轮次与预算计数，绝不算完成）
  recoverGoalsOnStartup(sessionStore)
  recoverResearchOnStartup(sessionStore)
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
    ...dataDirInfo(),
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
