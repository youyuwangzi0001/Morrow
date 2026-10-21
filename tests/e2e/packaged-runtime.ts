/**
 * 打包版测试的运行时来源：最终交付只有单文件 exe，因此首次需要时先启动一次
 * 单文件启动器，把内嵌应用解压到 tmp/.morrow-runtime，再用解压出的 Morrow-app.exe
 * 跑 Playwright（单文件 exe 本身是 C# 启动器，不能直接作为 Electron 入口）。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { root } from './launch'

let pending: Promise<string | null> | null = null

export function getPackagedAppExe(): Promise<string | null> {
  if (!pending) pending = resolvePackagedAppExe()
  return pending
}

async function resolvePackagedAppExe(): Promise<string | null> {
  const override = process.env.MORROW_PACKAGED_EXE
  if (override && existsSync(override)) return override

  // 内部 --all 构建仍存在文件夹版时直接复用，避免多余的首次解压
  const folderExe = join(root, 'deliver', 'Morrow-0.1.0-portable', 'Morrow-app.exe')
  if (existsSync(folderExe)) return folderExe

  const single = join(root, 'deliver', 'Morrow-0.1.0-portable.exe')
  if (!existsSync(single)) return null

  const dir = join(root, 'tmp', 'packaged-single-runtime')
  const runtimeDir = join(dir, '.morrow-runtime-0.1.0')
  const appExe = join(runtimeDir, 'Morrow-app.exe')
  const stamp = join(runtimeDir, '.morrow-runtime-complete')
  const marker = join(dir, '.single-sha256')
  const hash = createHash('sha256').update(readFileSync(single)).digest('hex')

  if (
    existsSync(appExe) &&
    existsSync(stamp) &&
    existsSync(marker) &&
    readFileSync(marker, 'utf8').trim() === hash
  ) {
    return appExe
  }

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const launcher = join(dir, 'Morrow-0.1.0-portable.exe')
  copyFileSync(single, launcher)
  writeFileSync(marker, `${hash}\n`, 'utf8')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MORROW_TEST: '1',
    MORROW_SKIP_DESKTOP_SHORTCUT: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(launcher, [`--data-dir=${join(dir, 'data')}`], {
    cwd: dir,
    env,
    stdio: 'ignore',
    windowsHide: true
  })
  const deadline = Date.now() + 90_000
  try {
    while (Date.now() < deadline) {
      if (existsSync(appExe) && existsSync(stamp)) break
      await delay(300)
    }
    if (!existsSync(appExe) || !existsSync(stamp)) {
      throw new Error('单文件便携版运行时解压失败：请检查 deliver/Morrow-0.1.0-portable.exe')
    }
  } finally {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // 进程可能已退出
    }
  }
  return appExe
}
