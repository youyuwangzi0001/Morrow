import { app } from 'electron'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { DataDirSource } from '../../shared/types'

/**
 * 便携版数据目录策略：
 * 1. --data-dir=<path> 最高优先级（测试/高级用户）
 * 2. 用户在「设置 → 关于」中选择的自定义目录（指针存在 %LOCALAPPDATA%\Morrow）
 * 3. 便携文件夹版：exe 同级存在 portable.marker → <exe 目录>/Morrow Data
 * 4. 便携单文件版：PORTABLE_EXECUTABLE_DIR/Morrow Data
 * 5. 默认 Electron userData（%APPDATA%/Morrow）
 * 注意：app.setPath 只接受绝对路径，这里统一 resolve。
 */

function dataDirArg(): string | null {
  const arg = process.argv.find((item) => item.startsWith('--data-dir='))
  if (!arg) return null
  const value = arg.slice('--data-dir='.length)
  return value ? resolve(value) : null
}

export function hasDataDirArg(): boolean {
  return dataDirArg() !== null
}

/** 自定义目录指针放在数据目录之外，切换数据目录后仍能记住选择。 */
export function dataLocationFile(): string {
  const explicit = process.env.MORROW_DATA_LOCATION_FILE
  if (explicit) return resolve(explicit)
  const base = process.env.LOCALAPPDATA || app.getPath('appData')
  return join(base, 'Morrow', 'data-location.json')
}

export function readDataLocation(file = dataLocationFile()): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { dataDir?: unknown }
    if (typeof parsed.dataDir !== 'string' || !isAbsolute(parsed.dataDir)) return null
    return resolve(parsed.dataDir)
  } catch {
    return null
  }
}

export function writeDataLocation(dir: string, file = dataLocationFile()): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({ dataDir: resolve(dir), updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8'
  )
}

export function removeDataLocation(file = dataLocationFile()): void {
  rmSync(file, { force: true })
}

/** 不含用户自定义指针的默认目录（用于「恢复默认」与界面说明）。 */
export function resolveDefaultDataDir(): string {
  const exeDir = dirname(process.execPath)
  if (existsSync(join(exeDir, 'portable.marker'))) {
    return join(exeDir, 'Morrow Data')
  }
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir) return join(portableDir, 'Morrow Data')
  return join(app.getPath('appData'), 'Morrow')
}

let cachedDataDir: string | null = null

export function resetResolveDataDirCacheForTests(): void {
  cachedDataDir = null
}

export function resolveDataDir(): string {
  if (cachedDataDir) return cachedDataDir
  const arg = dataDirArg()
  if (arg) {
    cachedDataDir = arg
    return cachedDataDir
  }
  const custom = readDataLocation()
  if (custom) {
    try {
      mkdirSync(custom, { recursive: true })
      cachedDataDir = custom
      return cachedDataDir
    } catch {
      // 自定义目录不可用（盘符断开/无权限）时回退默认目录，指针保留给设置页修复
    }
  }
  cachedDataDir = resolve(resolveDefaultDataDir())
  return cachedDataDir
}

export function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string => resolve(value).replace(/[\\/]+$/, '').toLowerCase()
  return normalize(a) === normalize(b)
}

/** child 是否位于 parent 内部；用于阻止迁移时目录互相包含。 */
export function isNestedPath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

export function canChangeDataDir(): boolean {
  // 测试需要在不重启的情况下验证选择/迁移链路；生产环境仍由 --data-dir 锁定
  return !hasDataDirArg() || process.env.MORROW_ALLOW_DATA_DIR_CHANGE === '1'
}

export interface DataDirInfo {
  dataDir: string
  defaultDataDir: string
  customDataDir: string | null
  dataDirSource: DataDirSource
  canChangeDataDir: boolean
}

export function dataDirInfo(): DataDirInfo {
  const dataDir = app.getPath('userData')
  const defaultDataDir = resolveDefaultDataDir()
  const customDataDir = readDataLocation()
  let dataDirSource: DataDirSource = 'default'
  if (hasDataDirArg()) {
    dataDirSource = 'arg'
  } else if (customDataDir && samePath(dataDir, customDataDir)) {
    dataDirSource = 'custom'
  } else if (existsSync(join(dirname(process.execPath), 'portable.marker')) || process.env.PORTABLE_EXECUTABLE_DIR) {
    dataDirSource = 'portable'
  }
  return {
    dataDir,
    defaultDataDir,
    customDataDir,
    dataDirSource,
    canChangeDataDir: canChangeDataDir()
  }
}

export function dataPath(...segments: string[]): string {
  return join(app.getPath('userData'), ...segments)
}

export function ensureDataDirs(): void {
  const dirs = ['sessions', 'snapshots', 'logs', 'providers', 'demo', 'tmp', 'attachments', 'schedules']
  for (const dir of dirs) {
    const path = dataPath(dir)
    if (!existsSync(path)) mkdirSync(path, { recursive: true })
  }
}

/** 迁移数据目录时跳过的 Chromium 缓存/瞬时状态；对话、设置、项目、记忆等用户数据仍会复制。 */
export const MIGRATION_SKIP_NAMES = new Set([
  'Cache',
  'Cache_Data',
  'Code Cache',
  'GPUCache',
  'GPUPersistentCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'blob_storage',
  'Network',
  'Session Storage',
  'Local Storage',
  'Partitions',
  'Service Worker',
  'Shared Dictionary',
  'Dictionaries',
  'Crashpad',
  'crashpad',
  'tmp',
  '.morrow-temp',
  'logs',
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'DevToolsActivePort',
  'lockfile'
])

function shouldSkip(name: string): boolean {
  return MIGRATION_SKIP_NAMES.has(name)
}

/**
 * 将现有数据目录复制到新目录（不删除源目录）。
 * 被浏览器/索引器短暂占用的文件跳过，其余错误照常抛出；目标目录必须为空。
 */
export function copyUserDataForMigration(from: string, to: string): number {
  const source = resolve(from)
  const target = resolve(to)
  if (!existsSync(source)) throw new Error('当前数据目录不存在。')
  mkdirSync(target, { recursive: true })
  let copied = 0

  const walk = (relativeDir: string): void => {
    const sourceDir = join(source, relativeDir)
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (shouldSkip(entry.name)) continue
      const childRelative = relativeDir ? join(relativeDir, entry.name) : entry.name
      const sourcePath = join(source, childRelative)
      const targetPath = join(target, childRelative)
      if (entry.isDirectory()) {
        mkdirSync(targetPath, { recursive: true })
        walk(childRelative)
        continue
      }
      if (!entry.isFile()) continue
      try {
        copyFileSync(sourcePath, targetPath)
        copied += 1
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        // 运行中的应用/浏览器可能短暂占用个别文件；用户数据 JSON 不常驻打开，跳过即可
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') continue
        throw err
      }
    }
  }

  walk('')
  return copied
}

/** 迁移失败时清空目标目录中已复制的文件（不会删除用户选择的文件夹本身）。 */
export function cleanTargetDataDir(dir: string): void {
  const target = resolve(dir)
  if (!existsSync(target)) return
  for (const entry of readdirSync(target)) {
    rmSync(join(target, entry), { recursive: true, force: true })
  }
}

/** 路径是否位于根目录内；Windows 下大小写不敏感，比较解析后的绝对路径。 */
export function isPathInside(root: string, target: string): boolean {
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = fold(resolve(root))
  const candidate = fold(resolve(target))
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return candidate === base || candidate.startsWith(prefix)
}
