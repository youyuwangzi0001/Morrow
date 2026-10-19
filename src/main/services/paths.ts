import { app } from 'electron'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

/**
 * 便携版数据目录策略：
 * 1. --data-dir=<path> 最高优先级（测试/高级用户）
 * 2. 便携文件夹版：exe 同级存在 portable.marker → <exe 目录>/Morrow Data
 * 3. 便携单文件版（NSIS 自解压）：PORTABLE_EXECUTABLE_DIR/Morrow Data
 * 4. 默认 Electron userData（%APPDATA%/Morrow）
 * 注意：app.setPath 只接受绝对路径，这里统一 resolve。
 */
export function resolveDataDir(): string {
  const arg = process.argv.find((a) => a.startsWith('--data-dir='))
  if (arg) {
    const dir = arg.slice('--data-dir='.length)
    if (dir) return resolve(dir)
  }
  const exeDir = dirname(process.execPath)
  if (existsSync(join(exeDir, 'portable.marker'))) {
    return join(exeDir, 'Morrow Data')
  }
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir) return join(portableDir, 'Morrow Data')
  return join(app.getPath('appData'), 'Morrow')
}

export function dataPath(...segments: string[]): string {
  return join(app.getPath('userData'), ...segments)
}

export function ensureDataDirs(): void {
  const dirs = ['sessions', 'snapshots', 'logs', 'providers', 'demo', 'tmp', 'attachments']
  for (const dir of dirs) {
    const path = dataPath(dir)
    if (!existsSync(path)) mkdirSync(path, { recursive: true })
  }
}
