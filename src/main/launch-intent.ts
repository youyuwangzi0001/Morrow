// 通知点击意图：Windows 从侧边通知栏点开 Morrow 时，会经 COM 激活器重新拉起一个进程，
// 新进程拿不到「点的是哪条通知」。把目标会话先落到数据目录里，让接管界面的进程能把用户送回那轮任务。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataPath } from './workspace'
import { log } from './logger'

/**
 * 意图有效期。
 * 应用在运行时，点击通知由第二实例立刻转交给主实例，与时长无关；
 * 这个时长只覆盖「应用已退出、通知还留在操作中心」的情况。
 * 用户手动关掉通知时会立刻清除意图，所以这里不必压得太短。
 */
const FOCUS_INTENT_TTL_MS = 5 * 60_000

interface FocusIntent {
  sessionId: string
  at: number
}

function intentFile(): string {
  return join(dataPath(), 'runtime', 'pending-focus.json')
}

/** 记下「刚为哪个会话弹了通知」；点击或过期后由 consume/clear 清掉。 */
export function rememberFocusIntent(sessionId: string): void {
  try {
    const file = intentFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ sessionId, at: Date.now() } satisfies FocusIntent), 'utf8')
  } catch (err) {
    log.warn('focus intent write failed', { error: String(err) })
  }
}

export function clearFocusIntent(): void {
  try {
    rmSync(intentFile(), { force: true })
  } catch {
    // 文件不存在或目录不可写时无需处理
  }
}

/** 取出并删除意图；过期、损坏或已不可用时返回 null。 */
export function consumeFocusIntent(): string | null {
  let file: string
  try {
    file = intentFile()
  } catch {
    return null
  }
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<FocusIntent>
    if (typeof parsed.sessionId !== 'string' || typeof parsed.at !== 'number') return null
    if (Date.now() - parsed.at > FOCUS_INTENT_TTL_MS) return null
    return parsed.sessionId
  } catch {
    return null
  } finally {
    clearFocusIntent()
  }
}

/**
 * 只读不删：拿到单实例锁之前先确认有没有意图，失败的一方不能把意图消耗掉，
 * 否则主实例永远收不到这次点击。
 */
export function peekFocusIntent(): string | null {
  try {
    const file = intentFile()
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<FocusIntent>
    if (typeof parsed.sessionId !== 'string' || typeof parsed.at !== 'number') return null
    if (Date.now() - parsed.at > FOCUS_INTENT_TTL_MS) return null
    return parsed.sessionId
  } catch {
    return null
  }
}