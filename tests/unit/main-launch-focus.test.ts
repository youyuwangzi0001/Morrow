/**
 * 通知点击的启动链路：
 * 1) Windows COM 激活器直接拉起运行时里的 Morrow-app.exe 时，必须仍落在便携数据目录，
 *    否则单实例锁按 userData 区分，会真的再开一个 Morrow；
 * 2) 点击意图的写入/消费/过期。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let appDataDir = ''

const electronState = vi.hoisted(() => ({ dataDir: '', appDataDir: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return electronState.dataDir
      if (name === 'appData') return electronState.appDataDir
      return join(electronState.dataDir, name)
    }
  },
  shell: { showItemInFolder: () => undefined, openPath: async () => '' }
}))

const {
  resolveDefaultDataDir,
  portableHostDir,
  dataDirInfo
} = await import('../../src/main/workspace')
const { resolveMcpDataDir } = await import('../../src/core/tool-extra')
const { rememberFocusIntent, consumeFocusIntent, clearFocusIntent } = await import('../../src/main/launch-intent')

const dirs: string[] = []
let originalExecPath = ''

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 造一个便携包：根目录放 Morrow-*.exe，运行时子目录里放 Morrow-app.exe。 */
function makePortable(root: string): { root: string; runtimeDir: string; appExe: string } {
  const runtimeDir = join(root, '.morrow-runtime-0.2.0-r020')
  mkdirSync(runtimeDir, { recursive: true })
  writeFileSync(join(root, 'Morrow-0.2.0-portable.exe'), '')
  const appExe = join(runtimeDir, 'Morrow-app.exe')
  writeFileSync(appExe, '')
  return { root, runtimeDir, appExe }
}

beforeEach(() => {
  appDataDir = tempDir('morrow-appdata-')
  electronState.appDataDir = appDataDir
  electronState.dataDir = join(appDataDir, 'Morrow')
  originalExecPath = process.execPath
  delete process.env.PORTABLE_EXECUTABLE_DIR
})

afterEach(() => {
  process.execPath = originalExecPath
  delete process.env.PORTABLE_EXECUTABLE_DIR
  delete process.env.MORROW_DATA_DIR
  vi.restoreAllMocks()
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('便携运行时目录的宿主回溯', () => {
  it('@core:launch 运行时 exe 位于 .morrow-runtime-* 里时，默认数据目录落在便携包根', () => {
    const { root, appExe } = makePortable(tempDir('morrow-portable-'))
    mkdirSync(join(root, 'Morrow Data'), { recursive: true })
    process.execPath = appExe

    expect(portableHostDir(join(root, '.morrow-runtime-0.2.0-r020'))).toBe(root)
    // 通知激活器拉起的就是这个 exe，它没有 PORTABLE_EXECUTABLE_DIR。
    expect(resolveDefaultDataDir()).toBe(join(root, 'Morrow Data'))
  })

  it('@core:launch 宿主目录不像便携包时不认，避免误判同名目录', () => {
    const host = tempDir('morrow-plain-')
    const runtimeDir = join(host, '.morrow-runtime-0.2.0-r020')
    mkdirSync(runtimeDir, { recursive: true })

    expect(portableHostDir(runtimeDir)).toBeNull()
    expect(resolveDefaultDataDir()).toBe(join(appDataDir, 'Morrow'))
  })

  it('@core:launch 非运行时目录不做回溯，直接回 %APPDATA%', () => {
    const ordinary = tempDir('morrow-ordinary-')
    process.execPath = join(ordinary, 'Morrow-app.exe')

    expect(portableHostDir(ordinary)).toBeNull()
    expect(resolveDefaultDataDir()).toBe(join(appDataDir, 'Morrow'))
  })

  it('@core:launch 启动器注入的 PORTABLE_EXECUTABLE_DIR 仍然优先', () => {
    const { root, appExe } = makePortable(tempDir('morrow-portable-env-'))
    process.execPath = appExe
    process.env.PORTABLE_EXECUTABLE_DIR = root

    expect(resolveDefaultDataDir()).toBe(join(root, 'Morrow Data'))
  })

  it('@core:launch MCP 侧数据目录与主进程同规则，不因激活方式不同而分叉', () => {
    const { root, appExe } = makePortable(tempDir('morrow-portable-mcp-'))
    mkdirSync(join(root, 'Morrow Data'), { recursive: true })

    const viaRuntime = resolveMcpDataDir({
      env: { APPDATA: appDataDir },
      argv: [],
      execPath: appExe,
      platform: 'win32'
    })
    const viaLauncher = resolveMcpDataDir({
      env: { APPDATA: appDataDir, PORTABLE_EXECUTABLE_DIR: root },
      argv: [],
      execPath: join(root, 'Morrow.exe'),
      platform: 'win32'
    })

    expect(viaRuntime).toBe(join(root, 'Morrow Data'))
    expect(viaRuntime).toBe(viaLauncher)
  })

  it('@core:launch 设置页把回溯到的目录标为便携版', () => {
    const { appExe } = makePortable(tempDir('morrow-portable-info-'))
    process.execPath = appExe

    expect(dataDirInfo().dataDirSource).toBe('portable')
  })
})

describe('通知点击意图', () => {
  it('@core:launch 写入后能被取走，且只取一次', () => {
    rememberFocusIntent('session-42')

    expect(consumeFocusIntent()).toBe('session-42')
    expect(consumeFocusIntent()).toBeNull()
  })

  it('@core:launch 清除后不再返回', () => {
    rememberFocusIntent('session-42')
    clearFocusIntent()

    expect(consumeFocusIntent()).toBeNull()
  })

  it('@core:launch 没有记录时返回 null', () => {
    expect(consumeFocusIntent()).toBeNull()
  })

  it('@core:launch 过期意图不再生效，避免隔天启动被带到旧会话', () => {
    rememberFocusIntent('session-42')
    const file = join(electronState.dataDir, 'runtime', 'pending-focus.json')
    expect(existsSync(file)).toBe(true)
    // 直接把时间戳改到 TTL 之外
    writeFileSync(file, JSON.stringify({ sessionId: 'session-42', at: Date.now() - 11 * 60_000 }), 'utf8')

    expect(consumeFocusIntent()).toBeNull()
  })

  it('@core:launch 损坏的记录按无意图处理，不影响正常启动', () => {
    rememberFocusIntent('session-42')
    writeFileSync(join(electronState.dataDir, 'runtime', 'pending-focus.json'), '{not json', 'utf8')

    expect(consumeFocusIntent()).toBeNull()
  })
})