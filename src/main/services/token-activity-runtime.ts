/** Token 活动账本的进程级单例与历史回填入口。 */
import { resolveDataDir } from './paths'
import { getSessionStore } from './session-store'
import { TokenActivityService, type TokenUsageRecord } from './token-activity'
import { log } from './logger'

let instance: TokenActivityService | null = null
let legacySynced = false

export function getTokenActivityService(): TokenActivityService {
  if (!instance) instance = new TokenActivityService(resolveDataDir())
  return instance
}

/** 启动时执行一次历史回填；失败的旧会话不影响应用启动。 */
export function initializeTokenActivity(): void {
  if (legacySynced) return
  legacySynced = true
  try {
    const store = getSessionStore()
    const sessions = store
      .listAll()
      .map((meta) => store.get(meta.id))
      .filter((session): session is NonNullable<typeof session> => Boolean(session))
    getTokenActivityService().syncLegacy(sessions)
  } catch (err) {
    log.warn('token activity legacy sync failed', { error: String(err) })
  }
}

export function recordTokenUsage(input: TokenUsageRecord): void {
  try {
    getTokenActivityService().record(input)
  } catch (err) {
    log.warn('token activity record failed', { error: String(err) })
  }
}
