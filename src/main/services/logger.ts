import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dataPath } from './paths'

const MAX_SIZE = 5 * 1024 * 1024
const KEEP = 3

function logFile(): string {
  return dataPath('logs', 'main.log')
}

function ensure(): void {
  const dir = dataPath('logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

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
    // ignore
  }
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
