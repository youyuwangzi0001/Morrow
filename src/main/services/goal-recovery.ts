/**
 * 应用启动时的 Goal 恢复（R7 审计）。
 *
 * 问题：旧版本进程退出/崩溃后，session.goal 仍是 active；重开应用后目标条显示
 * 「进行中」但没有任何轮次在跑，用户也无法可靠继续。
 *
 * 规则：启动时把所有 active 目标转成 **paused**（可恢复），保留轮次、摘要与预算计数；
 * 绝不改成 completed。用户从目标条手动「继续」即可从下一轮接着做。
 */
import type { SessionStore } from './session-store'
import { log } from './logger'

let recoveredThisProcess = false

export const APP_RESTART_NOTE =
  '应用重启前目标正在运行，已自动暂停；轮次与预算计数已保留，可从目标条「继续」接着做。'

export function recoverGoalsOnStartup(sessionStore: SessionStore): number {
  if (recoveredThisProcess) return 0
  recoveredThisProcess = true
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

/** 测试辅助：允许同一进程内重复调用 */
export function resetGoalRecoveryForTests(): void {
  recoveredThisProcess = false
}
