import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
