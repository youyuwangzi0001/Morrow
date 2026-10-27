/**
 * 主进程进程级运行时：成品版本、Token 账本与搜索索引失效信号。
 * 纯服务类保持在各自模块里，便于直接用临时目录单测；这里只做单例装配与生命周期。
 */
import { dataPath, resolveDataDir } from './paths'
import { ArtifactVersionStore } from './artifact-versions'
import { TokenActivityService, type TokenUsageRecord } from './token-activity'
import { getSessionStore } from './session-store'
import { log } from './logger'

let artifactVersionStore: ArtifactVersionStore | null = null

export function getArtifactVersionStore(): ArtifactVersionStore {
  if (!artifactVersionStore) {
    artifactVersionStore = new ArtifactVersionStore({ dir: dataPath('artifact-versions') })
  }
  return artifactVersionStore
}

let tokenActivity: TokenActivityService | null = null
let legacyUsageSynced = false

export function getTokenActivityService(): TokenActivityService {
  if (!tokenActivity) tokenActivity = new TokenActivityService(resolveDataDir())
  return tokenActivity
}

/** 启动时执行一次历史回填；失败的旧会话不影响应用启动。 */
export function initializeTokenActivity(): void {
  if (legacyUsageSynced) return
  legacyUsageSynced = true
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

type SearchInvalidationHandler = (sessionId: string) => void | Promise<void>

let invalidateHandler: SearchInvalidationHandler | null = null
let clearHandler: (() => void | Promise<void>) | null = null

export function setSearchInvalidationHandler(next: SearchInvalidationHandler | null): void {
  invalidateHandler = next
}

export function setSearchClearHandler(next: (() => void | Promise<void>) | null): void {
  clearHandler = next
}

/** 会话删除/覆盖后通知索引失效。 */
export async function invalidateSearchSession(sessionId: string): Promise<void> {
  await invalidateHandler?.(sessionId)
}

/** 清除全部对话后立刻丢掉搜索索引里的会话条目。 */
export async function clearSearchIndex(): Promise<void> {
  await clearHandler?.()
}
