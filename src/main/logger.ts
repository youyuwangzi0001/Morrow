/**
 * 主进程日志：单文件 + 按大小轮转。
 *
 * 两处刻意的设计：
 *
 * · **所有写操作都吞异常**。日志写失败（磁盘满、权限错、文件被占用）绝不能让
 *   主流程崩掉 —— 一个「因为记不下来所以罢工」的日志系统比没有更糟。
 * · **每行是独立 JSON**。多进程同时写时，行级原子性足以保证不串行；
 *   换成跨行结构就要上锁了。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dataPath } from './workspace'

/** 单文件上限。5MB 能在用户反馈时随包带走，又不至于几十万行难读。 */
const MAX_SIZE = 5 * 1024 * 1024
/** 保留的历史份数（main.log.1 .. .3）。 */
const KEEP = 3

function logFile(): string {
  return dataPath('logs', 'main.log')
}

function ensure(): void {
  const dir = dataPath('logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * 超限时把 main.log 轮转成 .1、.2、.3。
 *
 * 从大到小重命名，避免覆盖：先把 .2→.3 再 .1→.2，最后 main→.1。
 * 顺着做会把 .2 直接冲掉。
 */
function rotate(): void {
  try {
    const file = logFile()
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_SIZE) return
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${file}.${i}`
      const to = `${file}.${i + 1}`
      if (existsSync(from)) renameSync(from, to)
    }
    renameSync(file, `${file}.1`)
  } catch {
    // 日志失败不影响主流程
  }
}

function write(level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, message, meta: meta ?? null }) + '\n'
  try {
    ensure()
    rotate()
    appendFileSync(logFile(), line, 'utf8')
  } catch {
  }
  // 测试里默认不往 stdout 写，否则几百条用例的噪音会淹没失败信息。
  // error 例外：测试中真的出错了，需要立刻看见。
  if (!process.env.MORROW_TEST || level === 'error') {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fn(`[morrow:${level}]`, message, meta ?? '')
  }
}

export const log = {
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta)
}
