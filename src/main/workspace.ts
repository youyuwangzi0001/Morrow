// 工作区、路径、文件预览、编辑历史与登录窗口。
import { BrowserWindow, session, app, shell, clipboard, dialog } from 'electron'
import { log } from './logger'
import { dirname, isAbsolute, join, relative, resolve, sep, basename, extname } from 'node:path'
import type { Stats, Dirent } from 'node:fs'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, closeSync, lstatSync, openSync, readSync, renameSync, statSync, createReadStream, mkdtempSync, unlinkSync, realpathSync } from 'node:fs'
import type { DataDirSource, FileSearchResult, WorkspaceInfo, Artifact, ChatMessage, Session, SessionMeta } from '../shared/types'
import { formatBytes } from '../shared/types'
import { connect } from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes, createHash } from 'node:crypto'
import { sha256 } from '@core/util'
import type { DiffResult } from '@core/tools'
import { inspectWorkspacePath, isPathInsideWorkspace, normalizeWorkspace, createUnifiedDiff } from '@core/tools'
import type { FilePreviewKind, FilePreviewMeta, ArchiveEntryPreview, ArchivePreviewResult, DocumentPreviewResult, PptxPreviewResult, PptxSlidePreview, XlsxPreviewResult, XlsxSheetPreview } from '../shared/contracts'
import { TEXT_PREVIEW_MAX_BYTES, ARCHIVE_PREVIEW_MAX_BYTES, DOCX_PREVIEW_MAX_BYTES, OFFICE_PREVIEW_MAX_BYTES, PDF_PREVIEW_MAX_BYTES, binaryPreviewKindForFileName, isLegacyOfficeFileName, isTextFileName, mimeTypeForFileName } from '../shared/contracts'
import { Readable } from 'node:stream'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import type { PdfOcrHandler, PdfOcrResult } from '../core/types'

const LOGIN_PARTITION = 'persist:morrow-login'

const LOGIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

const CHROME_BRANDS = '"Chromium";v="156", "Google Chrome";v="156", "Not?A_Brand";v="24"'

const CHROME_FULL_BRANDS =
  '"Chromium";v="156.0.0.0", "Google Chrome";v="156.0.0.0", "Not?A_Brand";v="24.0.0.0"'

let loginWindow: BrowserWindow | null = null

let headerHooksInstalled = false

function loginSession(): Electron.Session {
  const ses = session.fromPartition(LOGIN_PARTITION)
  ses.setUserAgent(LOGIN_UA)
  if (!headerHooksInstalled) {
    headerHooksInstalled = true
    // Electron 默认的 Client Hints 会暴露 Electron 身份，Cloudflare 因此要求
    // 额外的安全验证；把 UA-CH 对齐到 Chrome 后，真实的 ChatGPT 登录页可直接加载。
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders
      for (const key of Object.keys(headers)) {
        if (/^(user-agent|sec-ch-ua|accept-language)/i.test(key)) delete headers[key]
      }
      headers['User-Agent'] = LOGIN_UA
      headers['sec-ch-ua'] = CHROME_BRANDS
      headers['sec-ch-ua-mobile'] = '?0'
      headers['sec-ch-ua-platform'] = '"Windows"'
      headers['sec-ch-ua-full-version-list'] = CHROME_FULL_BRANDS
      headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8'
      callback({ requestHeaders: headers })
    })
  }
  return ses
}

function isLoginCallback(url: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1):1455\/auth\/callback(?:[/?#]|$)/i.test(url)
}

export function isLoginSession(ses: Electron.Session): boolean {
  return ses === session.fromPartition(LOGIN_PARTITION)
}

/**
 * 登录页需要在自己的窗口里完成整页跳转（Qoder 的“继续”就是同页导航）。
 * app 级 web-contents-created 给所有窗口装了“非应用地址一律拦截”的 will-navigate，
 * 这里对登录窗口及其 OAuth 子窗口解除该拦截，只保留 http(s) 白名单。
 */
function installLoginNavigation(window: BrowserWindow): void {
  const contents = window.webContents
  contents.removeAllListeners('will-navigate')
  contents.on('will-navigate', (event, target) => {
    if (!/^https?:\/\//i.test(target) && target !== 'about:blank') event.preventDefault()
  })
  contents.on('did-create-window', (child) => {
    child.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
      if (!/^https?:\/\//i.test(popupUrl)) return { action: 'deny' }
      return { action: 'allow' }
    })
    installLoginNavigation(child)
  })
}

export function openLoginWindow(url: string): boolean {
  try {
    loginSession()
    if (loginWindow && !loginWindow.isDestroyed()) {
      void loginWindow.loadURL(url)
      loginWindow.show()
      loginWindow.focus()
      return true
    }
    const window = new BrowserWindow({
      width: 520,
      height: 760,
      minWidth: 380,
      minHeight: 520,
      title: 'Morrow 登录',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        partition: LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    })
    loginWindow = window
    window.setMenuBarVisibility(false)
    window.webContents.setUserAgent(LOGIN_UA)
    window.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
      if (!/^https?:\/\//i.test(popupUrl)) return { action: 'deny' }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 760,
          autoHideMenuBar: true,
          webPreferences: {
            partition: LOGIN_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true
          }
        }
      }
    })
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    installLoginNavigation(window)
    window.webContents.on('did-navigate', (_event, target) => {
      if (isLoginCallback(target)) {
        // 本地回调已交给订阅服务的 1455 服务器，留一点时间完成响应再收起窗口。
        setTimeout(() => {
          if (!window.isDestroyed()) window.close()
        }, 900)
      }
    })
    window.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
      log.warn('login window load failed', { code, description, host: safeHost(failedUrl) })
    })
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) {
        window.show()
        window.focus()
      }
    })
    window.on('closed', () => {
      if (loginWindow === window) loginWindow = null
    })
    void window.loadURL(url).catch((err) => {
      log.warn('login window load rejected', { host: safeHost(url), message: String(err) })
    })
    return true
  } catch (err) {
    log.warn('login window create failed', { host: safeHost(url), message: String(err) })
    return false
  }
}

export function closeLoginWindow(): void {
  const window = loginWindow
  loginWindow = null
  if (window && !window.isDestroyed()) {
    try { window.close() } catch { /* window may be closing */ }
  }
}

function safeHost(url: string): string {
  try { return new URL(url).host } catch { return '' }
}

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

/** 创作台数据目录指针：与 Agent 数据目录解耦，存放在 LOCALAPPDATA\Morrow。 */
export function studioLocationFile(): string {
  const explicit = process.env.MORROW_STUDIO_LOCATION_FILE
  if (explicit) return resolve(explicit)
  const base = process.env.LOCALAPPDATA || app.getPath('appData')
  return join(base, 'Morrow', 'studio-location.json')
}

export function readStudioLocation(file = studioLocationFile()): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { studioRoot?: unknown }
    if (typeof parsed.studioRoot !== 'string' || !isAbsolute(parsed.studioRoot)) return null
    return resolve(parsed.studioRoot)
  } catch {
    return null
  }
}

export function writeStudioLocation(dir: string, file = studioLocationFile()): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({ studioRoot: resolve(dir), updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8'
  )
}

export function removeStudioLocation(file = studioLocationFile()): void {
  rmSync(file, { force: true })
}

export function resolveDefaultStudioRoot(dataDir = resolveDataDir()): string {
  return join(dataDir, 'studio')
}

/** 自定义创作台目录可用时优先使用；不可用时回退到 Agent 数据目录下的 studio。 */
export function resolveStudioDataRoot(dataDir = resolveDataDir()): string {
  const custom = readStudioLocation()
  if (custom) {
    try {
      mkdirSync(custom, { recursive: true })
      return custom
    } catch {
      // 盘符断开/无权限时回退默认，指针保留给设置页修复
    }
  }
  return resolveDefaultStudioRoot(dataDir)
}

export interface StudioDataDirInfo {
  root: string
  defaultRoot: string
  customRoot: string | null
  source: 'default' | 'custom'
}

export function studioDataDirInfo(dataDir = resolveDataDir()): StudioDataDirInfo {
  const root = resolveStudioDataRoot(dataDir)
  const defaultRoot = resolveDefaultStudioRoot(dataDir)
  const customRoot = readStudioLocation()
  return {
    root,
    defaultRoot,
    customRoot,
    source: customRoot && samePath(root, customRoot) ? 'custom' : 'default'
  }
}

const LAUNCHER_PIPE_ENV = 'MORROW_LAUNCHER_PIPE'

const BROKER_TIMEOUT_MS = 5_000

const CONNECT_RETRIES = 5

const RETRY_DELAY_MS = 250

type BrokerResult =
  | { kind: 'ok' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

/**
 * 请求启动器代理执行 OPEN / REVEAL。代理只接受绝对且真实存在的路径；
 * 通过命名管道传递 Base64，避免引号、空格和中文路径的转义问题。
 */
function askLauncher(command: 'OPEN' | 'REVEAL', target: string): Promise<BrokerResult> {
  const pipe = process.env[LAUNCHER_PIPE_ENV]?.trim()
  if (process.platform !== 'win32' || !pipe) return Promise.resolve({ kind: 'unavailable' })
  return new Promise((resolve) => {
    let settled = false
    let buffer = ''
    let attempt = 0
    let socket: ReturnType<typeof connect> | null = null
    let timer: NodeJS.Timeout

    const finish = (result: BrokerResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(result)
    }

    const start = (): void => {
      buffer = ''
      socket = connect(`\\\\.\\pipe\\${pipe}`)
      socket.setEncoding('utf8')
      socket.on('connect', () => {
        socket?.write(`${command} ${Buffer.from(target, 'utf8').toString('base64')}\n`)
      })
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline).trim()
        if (line === 'OK') {
          finish({ kind: 'ok' })
          return
        }
        finish({ kind: 'error', message: line.replace(/^ERR\t?/, '').trim() || '启动器代理执行失败' })
      })
      socket.on('error', (err: NodeJS.ErrnoException) => {
        // 任务代理刚被系统拉起来时管道可能晚几十毫秒；短暂重试，避免第一次点击落空。
        if ((err.code === 'ENOENT' || err.code === 'ECONNREFUSED') && attempt < CONNECT_RETRIES) {
          attempt += 1
          setTimeout(start, RETRY_DELAY_MS)
          return
        }
        finish({ kind: 'error', message: err.message })
      })
      socket.on('close', () => finish({ kind: 'error', message: '启动器代理连接已关闭' }))
    }

    timer = setTimeout(() => finish({ kind: 'error', message: '启动器代理响应超时' }), BROKER_TIMEOUT_MS)
    start()
  })
}

function existingTarget(absolutePath: string): boolean {
  try {
    return existsSync(absolutePath)
  } catch {
    return false
  }
}

/**
 * 在资源管理器中选中目标。返回 null 表示已成功（至少已交给系统），
 * 返回字符串表示失败原因。
 */
export async function revealInFileManager(absolutePath: string): Promise<string | null> {
  if (!existingTarget(absolutePath)) return '文件不存在或已被移动。'

  if (process.platform === 'win32' && process.env[LAUNCHER_PIPE_ENV]?.trim()) {
    const broker = await askLauncher('REVEAL', absolutePath)
    if (broker.kind === 'ok') return null
    if (broker.kind === 'error') {
      log.warn('launcher reveal failed', { path: absolutePath, error: broker.message })
      return broker.message
    }
  }

  try {
    shell.showItemInFolder(absolutePath)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** 用系统默认程序打开文件/文件夹。返回 null 表示成功，字符串表示错误。 */
export async function openPathFromUserShell(absolutePath: string): Promise<string | null> {
  if (!existingTarget(absolutePath)) return '文件不存在或已被移动。'

  if (process.platform === 'win32' && process.env[LAUNCHER_PIPE_ENV]?.trim()) {
    const broker = await askLauncher('OPEN', absolutePath)
    if (broker.kind === 'ok') return null
    if (broker.kind === 'error') {
      log.warn('launcher open failed', { path: absolutePath, error: broker.message })
      return broker.message
    }
  }

  const error = await shell.openPath(absolutePath)
  return error || null
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

export async function openExternalUrl(url: string): Promise<{ opened: boolean; copied: boolean }> {
  if (!isHttpUrl(url)) throw new Error('只能打开 http(s) 链接。')
  if (process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')) {
    clipboard.writeText(url)
    return { opened: false, copied: true }
  }
  if (process.platform === 'win32') {
    try {
      await shell.openExternal(url)
      return { opened: true, copied: false }
    } catch {
      // 交给系统 URL 处理器兜底
    }
    try {
      await promisify(execFile)('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        windowsHide: true,
        timeout: 8_000
      })
      return { opened: true, copied: false }
    } catch {
      // 继续尝试 Electron 的实现
    }
  }
  try {
    await shell.openExternal(url)
    return { opened: true, copied: false }
  } catch {
    try {
      clipboard.writeText(url)
    } catch {
      // 剪贴板也可能不可用
    }
    return { opened: false, copied: true }
  }
}

/**
 * 登录授权页专用：始终在 Morrow 内置 BrowserWindow 打开。
 *
 * 外部浏览器路径在这台机器上不可靠：UAC 关闭后系统 Edge 是 High 完整性，
 * 而 Morrow 可能是 Low/Medium；跨完整性的 Edge 会白屏并弹出重启提示。
 * 内置 Chromium 不经过系统浏览器单例，用户登录后的回调/轮询仍由原服务处理。
 */
export async function openLoginUrl(url: string): Promise<{ opened: boolean; copied: boolean }> {
  if (!isHttpUrl(url)) throw new Error('只能打开 http(s) 链接。')
  if (process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')) {
    clipboard.writeText(url)
    return { opened: false, copied: true }
  }
  try {
    clipboard.writeText(url)
  } catch {
    // 剪贴板不可用时仍尝试打开内置登录窗口
  }
  if (openLoginWindow(url)) return { opened: true, copied: true }
  log.warn('login window unavailable')
  return { opened: false, copied: true }
}

/** 不关心结果的场景（普通外部链接）；失败时仍有剪贴板兜底。 */
export function openExternalQuiet(url: string): void {
  void openExternalUrl(url).catch(() => undefined)
}

export function openLoginQuiet(url: string): void {
  void openLoginUrl(url).catch(() => undefined)
}

/** 以采样方式判断内容是否像二进制；用于编辑器打开与附件分类。 */
export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192)
  if (sample.includes(0)) return true
  const text = sample.toString('utf8')
  if (!text) return false
  let replacement = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) replacement += 1
  }
  return replacement / Math.max(1, text.length) > 0.1
}

export const MAX_READ_BYTES = TEXT_PREVIEW_MAX_BYTES

export const MAX_WRITE_BYTES = 8 * 1024 * 1024

export const MAX_LIST_ENTRIES = 2000

export type WorkspaceEntryKind = 'file' | 'dir' | 'symlink'

export interface WorkspaceFileEntry {
  name: string
  /** 工作区相对路径（posix 分隔） */
  path: string
  kind: WorkspaceEntryKind
  size: number
  mtimeMs: number
  isSymlink: boolean
  /** symlink 解析后超出工作区 / 无法解析：UI 不允许展开与操作 */
  restricted?: boolean
}

export class WorkspaceFileError extends Error {
  code: string
  hint?: string
  mtimeMs?: number

  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.name = 'WorkspaceFileError'
    this.code = code
    if (hint) this.hint = hint
  }
}

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

/** 工作区相对路径；根目录返回 '' */
export function toWorkspaceRelative(workspace: string, absolute: string): string {
  const rel = relative(normalizeWorkspace(workspace), absolute)
  if (!rel) return ''
  return toPosix(rel)
}

function requireWorkspace(workspace: string): string {
  const raw = typeof workspace === 'string' ? workspace.trim() : ''
  if (!raw) throw new WorkspaceFileError('NO_WORKSPACE', '还没有选择工作文件夹，不能操作文件。', '请先选择一个工作文件夹。')
  return normalizeWorkspace(raw)
}

function resolveInside(workspace: string, inputPath: string): ReturnType<typeof inspectWorkspacePath> {
  const ws = requireWorkspace(workspace)
  let resolved
  try {
    resolved = inspectWorkspacePath(inputPath, ws)
  } catch (err) {
    throw new WorkspaceFileError('INVALID_PATH', err instanceof Error ? err.message : '路径不合法。')
  }
  if (!resolved.inside) {
    throw new WorkspaceFileError(
      'OUTSIDE_WORKSPACE',
      '这个路径在工作区之外，已被拦下。',
      'Morrow 只能操作你选择的工作文件夹里的文件。'
    )
  }
  return resolved
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFileLike(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile()
  } catch {
    return false
  }
}

function lstatSafe(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function entryFor(resolvedAbsolute: string, workspaceReal: string): WorkspaceFileEntry {
  const first = lstatSafe(resolvedAbsolute)
  if (!first) throw new WorkspaceFileError('NOT_FOUND', '这个文件或文件夹已经不存在了。', '可以刷新文件树后重试。')
  const isSymlink = first.isSymbolicLink()
  const target = isSymlink ? statSyncSafe(resolvedAbsolute) : first
  const shape = target ?? first
  let restricted = false
  if (isSymlink) {
    try {
      const probe = inspectWorkspacePath(resolvedAbsolute, workspaceReal)
      restricted = !probe.inside || !probe.exists
    } catch {
      restricted = true
    }
  }
  const kind: WorkspaceEntryKind = isSymlink ? 'symlink' : first.isDirectory() ? 'dir' : 'file'
  return {
    name: basename(resolvedAbsolute),
    path: toWorkspaceRelative(workspaceReal, resolvedAbsolute),
    kind,
    size: shape.isDirectory() ? 0 : shape.size,
    mtimeMs: shape.mtimeMs,
    isSymlink,
    ...(restricted ? { restricted: true } : {})
  }
}

function statSyncSafe(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** 在工作区内查找某个路径所属的工作区（供编辑器只传 {path} 时回退使用） */
export function findWorkspaceContaining(inputPath: string, candidates: string[]): string | null {
  const raw = (inputPath ?? '').trim()
  if (!raw) return null
  for (const candidate of candidates) {
    const ws = normalizeWorkspace(candidate)
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(ws, raw)
    if (isPathInsideWorkspace(absolute, ws)) return ws
  }
  return null
}

export interface ListWorkspaceInput {
  dir?: string
  showHidden?: boolean
  limit?: number
}

export function listWorkspaceEntries(workspace: string, options: ListWorkspaceInput = {}): {
  workspace: string
  dir: string
  entries: WorkspaceFileEntry[]
  limited: boolean
} {
  const ws = requireWorkspace(workspace)
  const requested = options.dir && options.dir.trim() ? options.dir.trim() : '.'
  const resolved = resolveInside(ws, requested)
  if (!resolved.exists) throw new WorkspaceFileError('NOT_FOUND', '这个文件夹已经不存在了。', '刷新文件树后重试。')
  if (!resolved.isDirectory) throw new WorkspaceFileError('NOT_A_DIR', '这不是一个文件夹。')
  const showHidden = options.showHidden === true
  const limit = Math.max(1, Math.min(MAX_LIST_ENTRIES, options.limit ?? MAX_LIST_ENTRIES))
  let names: string[]
  try {
    names = readdirSync(resolved.absolute)
  } catch (err) {
    throw new WorkspaceFileError('LIST_FAILED', `读取文件夹失败：${err instanceof Error ? err.message : String(err)}`)
  }
  const entries: WorkspaceFileEntry[] = []
  let limited = false
  for (const name of names) {
    if (entries.length >= limit) {
      limited = true
      break
    }
    if (!showHidden && name.startsWith('.')) continue
    const full = join(resolved.absolute, name)
    try {
      entries.push(entryFor(full, ws))
    } catch {
      // 单个坏链接/权限问题不影响整棵树
      const info = lstatSafe(full)
      if (!info) continue
      entries.push({
        name,
        path: toWorkspaceRelative(ws, full),
        kind: info.isDirectory() ? 'dir' : 'file',
        size: info.isDirectory() ? 0 : info.size,
        mtimeMs: info.mtimeMs,
        isSymlink: false,
        restricted: true
      })
    }
  }
  entries.sort((a, b) => {
    const aIsDir = a.kind !== 'file'
    const bIsDir = b.kind !== 'file'
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  })
  return { workspace: ws, dir: toWorkspaceRelative(ws, resolved.absolute), entries, limited }
}

export interface ReadWorkspaceResult {
  path: string
  absolutePath: string
  content: string
  size: number
  mtimeMs: number
  encoding: 'utf8'
  truncated: boolean
}

export function readWorkspaceFile(
  workspace: string,
  inputPath: string,
  options: { maxBytes?: number } = {}
): ReadWorkspaceResult {
  const ws = requireWorkspace(workspace)
  const resolved = resolveInside(ws, inputPath)
  if (!resolved.exists) throw new WorkspaceFileError('NOT_FOUND', '这个文件已经不存在了。', '可以刷新文件树后重试。')
  if (resolved.isDirectory) throw new WorkspaceFileError('NOT_A_FILE', '这是一个文件夹，不能作为文本文件打开。')
  const stat = statSync(resolved.absolute)
  const maxBytes = Math.max(1024, Math.min(MAX_READ_BYTES, options.maxBytes ?? MAX_READ_BYTES))
  const truncated = stat.size > maxBytes
  let buffer: Buffer
  try {
    if (!truncated) {
      buffer = readFileSync(resolved.absolute)
    } else {
      const fd = openSync(resolved.absolute, 'r')
      try {
        const prefix = Buffer.alloc(maxBytes)
        let offset = 0
        while (offset < maxBytes) {
          const read = readSync(fd, prefix, offset, maxBytes - offset, offset)
          if (read <= 0) break
          offset += read
        }
        buffer = prefix.subarray(0, offset)
      } finally {
        closeSync(fd)
      }
    }
  } catch (err) {
    throw new WorkspaceFileError('READ_FAILED', `读取文件失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (isProbablyBinary(buffer)) {
    throw new WorkspaceFileError(
      'BINARY',
      '这是一个二进制文件，编辑器不能以文本方式打开。',
      '图片/文档等二进制文件可以交给 Morrow 预览，但不能直接编辑源码。'
    )
  }
  return {
    path: toWorkspaceRelative(ws, resolved.absolute),
    absolutePath: resolved.absolute,
    content: buffer.toString('utf8'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    encoding: 'utf8',
    truncated
  }
}

export interface WorkspaceFileStat {
  path: string
  absolutePath: string
  kind: 'file' | 'dir'
  size: number
  mtimeMs: number
}

export function statWorkspaceFile(workspace: string, inputPath: string): WorkspaceFileStat {
  const ws = requireWorkspace(workspace)
  const resolved = resolveInside(ws, inputPath)
  if (!resolved.exists) throw new WorkspaceFileError('NOT_FOUND', '文件或文件夹已经不存在了。')
  const stat = statSync(resolved.absolute)
  return {
    path: toWorkspaceRelative(ws, resolved.absolute),
    absolutePath: resolved.absolute,
    kind: stat.isDirectory() ? 'dir' : 'file',
    size: stat.isDirectory() ? 0 : stat.size,
    mtimeMs: stat.mtimeMs
  }
}

export interface SnapshotRecord {
  snapshotPath: string
  targetPath: string
  beforeHash: string | null
  afterHash: string
  at: number
  source: string
}

function snapshotPathFor(snapshotRoot: string, target: string, stamp: string): string {
  const date = new Date()
  const folder = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const safeName = basename(target).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').slice(0, 80) || 'file'
  return join(snapshotRoot, 'files', folder, `${stamp}-${randomBytes(3).toString('hex')}-${safeName}`)
}

function takeSnapshot(input: {
  snapshotRoot: string
  target: string
  afterHash: string
  source: string
}): SnapshotRecord | null {
  const before = statSyncSafe(input.target)
  if (!before || before.isDirectory()) return null
  const stamp = `${Date.now()}`
  const snapshotPath = snapshotPathFor(input.snapshotRoot, input.target, stamp)
  try {
    const data = readFileSync(input.target)
    mkdirSync(dirname(snapshotPath), { recursive: true })
    writeFileSync(snapshotPath, data)
    const beforeHash = sha256(data)
    const record: SnapshotRecord = {
      snapshotPath,
      targetPath: input.target,
      beforeHash,
      afterHash: input.afterHash,
      at: Date.now(),
      source: input.source
    }
    writeFileSync(
      join(dirname(snapshotPath), `${stamp}-${randomBytes(2).toString('hex')}.restore.json`),
      JSON.stringify({ ...record, version: 1 }, null, 2),
      'utf8'
    )
    return record
  } catch {
    return null
  }
}

export interface WriteWorkspaceResult {
  path: string
  absolutePath: string
  size: number
  mtimeMs: number
  created: boolean
  snapshot?: string
}

export function writeWorkspaceFile(
  workspace: string,
  inputPath: string,
  content: string,
  options: { snapshotRoot: string; expectedMtimeMs?: number | null; source?: string; maxBytes?: number }
): WriteWorkspaceResult {
  const ws = requireWorkspace(workspace)
  const resolved = resolveInside(ws, inputPath)
  if (resolved.exists && resolved.isDirectory) {
    throw new WorkspaceFileError('NOT_A_FILE', '这是一个文件夹，不能写入文本。')
  }
  const maxBytes = Math.max(1024, Math.min(MAX_WRITE_BYTES, options.maxBytes ?? MAX_WRITE_BYTES))
  const buffer = Buffer.from(typeof content === 'string' ? content : '', 'utf8')
  if (buffer.length > maxBytes) {
    throw new WorkspaceFileError('TOO_LARGE', `内容超过 ${formatBytes(maxBytes)}，已取消保存。`)
  }
  const existed = resolved.exists
  const before = existed ? statSyncSafe(resolved.absolute) : null
  if (options.expectedMtimeMs !== undefined && options.expectedMtimeMs !== null) {
    if (!before) {
      throw conflictError(null)
    }
    if (Math.abs(before.mtimeMs - options.expectedMtimeMs) > 1) {
      throw conflictError(before.mtimeMs)
    }
  }
  const target = resolved.absolute
  const dir = dirname(target)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    throw new WorkspaceFileError('WRITE_FAILED', `创建上级文件夹失败：${err instanceof Error ? err.message : String(err)}`)
  }
  // 双重校验：目录创建之后再 realpath 一次，防止中途被替换成指向外部的链接
  const recheck = resolveInside(ws, target)
  if (!recheck.inside) {
    throw new WorkspaceFileError('OUTSIDE_WORKSPACE', '写入目标落在工作区之外，已取消保存。')
  }
  const afterHash = sha256(buffer)
  const snapshot =
    existed && before && !before.isDirectory()
      ? takeSnapshot({
          snapshotRoot: options.snapshotRoot,
          target,
          afterHash,
          source: options.source ?? 'files-ui'
        })
      : null
  const temp = join(dir, `.morrow-tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    writeFileSync(temp, buffer, { encoding: 'utf8' })
    renameWithRetry(temp, target)
  } catch (err) {
    try {
      rmSync(temp, { force: true })
    } catch {
    }
    throw new WorkspaceFileError('WRITE_FAILED', `保存失败：${err instanceof Error ? err.message : String(err)}`)
  }
  const after = statSync(target)
  return {
    path: toWorkspaceRelative(ws, target),
    absolutePath: target,
    size: after.size,
    mtimeMs: after.mtimeMs,
    created: !existed,
    ...(snapshot ? { snapshot: snapshot.snapshotPath } : {})
  }
}

/** Windows 上杀毒/索引服务可能短暂占用目标文件，rename 会报 EPERM/EBUSY。 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
      if (attempt === 3) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
    }
  }
}

function conflictError(currentMtimeMs: number | null): WorkspaceFileError {  const error = new WorkspaceFileError(
    'MTIME_CONFLICT',
    '文件在编辑器打开后被外部修改了，已停止保存。请重新加载文件后再试。',
    '如果确认要用当前内容覆盖，请先重新加载文件，再保存一次。'
  )
  if (currentMtimeMs !== null) error.mtimeMs = currentMtimeMs
  return error
}

export function createWorkspaceEntry(
  workspace: string,
  inputPath: string,
  kind: 'file' | 'dir'
): WorkspaceFileEntry {
  const ws = requireWorkspace(workspace)
  const raw = (inputPath ?? '').trim()
  if (!raw || raw === '.' || raw === './') {
    throw new WorkspaceFileError('INVALID_PATH', '请给新文件或文件夹起一个名字。')
  }
  const resolved = resolveInside(ws, raw)
  if (resolved.exists) {
    throw new WorkspaceFileError('EXISTS', `「${basename(resolved.absolute)}」已经存在了，换一个名字。`)
  }
  const parent = dirname(resolved.absolute)
  if (!isDirectoryPath(parent)) {
    throw new WorkspaceFileError('PARENT_MISSING', '上级文件夹不存在，请先创建上级文件夹。')
  }
  if (kind === 'dir') {
    try {
      mkdirSync(resolved.absolute)
    } catch (err) {
      throw new WorkspaceFileError('CREATE_FAILED', `创建文件夹失败：${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    const temp = join(parent, `.morrow-tmp-${process.pid}-${randomBytes(3).toString('hex')}`)
    try {
      writeFileSync(temp, '', 'utf8')
      renameWithRetry(temp, resolved.absolute)
    } catch (err) {
      try {
        rmSync(temp, { force: true })
      } catch {
      }
      throw new WorkspaceFileError('CREATE_FAILED', `创建文件失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return entryFor(resolved.absolute, ws)
}

export interface RenameWorkspaceResult {
  from: string
  to: string
  kind: 'file' | 'dir'
}

export function renameWorkspaceEntry(workspace: string, fromPath: string, toPath: string): RenameWorkspaceResult {
  const ws = requireWorkspace(workspace)
  const from = resolveInside(ws, fromPath)
  const to = resolveInside(ws, toPath)
  if (!from.exists) throw new WorkspaceFileError('NOT_FOUND', '要重命名的文件或文件夹已经不存在了。')
  if (from.absolute === ws) throw new WorkspaceFileError('INVALID_PATH', '不能重命名工作区根目录。')
  if (to.exists) throw new WorkspaceFileError('EXISTS', '目标名称已经存在，未覆盖任何文件。')
  const parent = dirname(to.absolute)
  if (!isDirectoryPath(parent)) throw new WorkspaceFileError('PARENT_MISSING', '目标位置的上级文件夹不存在。')
  const isDir = from.isDirectory
  try {
    renameWithRetry(from.absolute, to.absolute)
  } catch (err) {
    throw new WorkspaceFileError('RENAME_FAILED', `重命名失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return { from: toWorkspaceRelative(ws, from.absolute), to: toWorkspaceRelative(ws, to.absolute), kind: isDir ? 'dir' : 'file' }
}

export function moveWorkspaceEntry(workspace: string, fromPath: string, toDirPath: string): RenameWorkspaceResult {
  const ws = requireWorkspace(workspace)
  const from = resolveInside(ws, fromPath)
  const dirInput = toDirPath && toDirPath.trim() ? toDirPath.trim() : '.'
  const toDir = resolveInside(ws, dirInput)
  if (!from.exists) throw new WorkspaceFileError('NOT_FOUND', '要移动的文件或文件夹已经不存在了。')
  if (!toDir.exists || !toDir.isDirectory) throw new WorkspaceFileError('NOT_A_DIR', '目标位置不是文件夹。')
  if (from.absolute === ws) throw new WorkspaceFileError('INVALID_PATH', '不能移动工作区根目录。')
  const target = join(toDir.absolute, basename(from.absolute))
  if (isPathInsideWorkspace(target, from.absolute)) {
    throw new WorkspaceFileError('INVALID_PATH', '不能把文件夹移动到它自己的子目录里。')
  }
  return renameWorkspaceEntry(ws, from.absolute, target)
}

export interface DeleteWorkspaceOptions {
  recursive?: boolean
  confirm?: boolean
}

export function deleteWorkspaceEntry(
  workspace: string,
  inputPath: string,
  options: DeleteWorkspaceOptions = {}
): { deleted: true; path: string; kind: 'file' | 'dir' } {
  const ws = requireWorkspace(workspace)
  const raw = (inputPath ?? '').trim()
  if (!raw || raw === '.' || raw === './') {
    throw new WorkspaceFileError('INVALID_PATH', '不能删除工作区根目录。')
  }
  if (options.confirm !== true) {
    throw new WorkspaceFileError('CONFIRM_REQUIRED', '删除文件需要二次确认。', '这是一个破坏性操作，请在确认后再调用。')
  }
  const resolved = resolveInside(ws, raw)
  if (!resolved.exists) throw new WorkspaceFileError('NOT_FOUND', '要删除的文件或文件夹已经不存在了。')
  const info = lstatSafe(resolved.absolute)
  const isDir = Boolean(info?.isDirectory())
  if (isDir && options.recursive !== true) {
    const children = readdirSync(resolved.absolute)
    if (children.length > 0) {
      throw new WorkspaceFileError(
        'DIR_NOT_EMPTY',
        `文件夹里还有 ${children.length} 项内容，确认后再递归删除。`,
        '请确认删除文件夹及其全部内容。'
      )
    }
  }
  try {
    rmSync(resolved.absolute, { recursive: isDir && options.recursive === true, force: false, maxRetries: 2, retryDelay: 40 })
  } catch (err) {
    throw new WorkspaceFileError('DELETE_FAILED', `删除失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return { deleted: true, path: toWorkspaceRelative(ws, resolved.absolute), kind: isDir ? 'dir' : 'file' }
}

/** 删除前预览（UI 二次确认展示内容数量） */
export function inspectWorkspaceEntry(workspace: string, inputPath: string): WorkspaceFileEntry & { childCount?: number } {
  const ws = requireWorkspace(workspace)
  const resolved = resolveInside(ws, inputPath)
  const entry = entryFor(resolved.absolute, ws)
  if (entry.kind === 'dir') {
    try {
      return { ...entry, childCount: readdirSync(resolved.absolute).length }
    } catch {
      return entry
    }
  }
  return entry
}

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000

const MAX_TOKENS = 1000

const PREVIEW_ORIGIN = 'morrow-file://preview'

const IMAGE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024

interface PreviewEntry {
  workspace: string
  filePath: string
  mime: string
  expiresAt: number
}

const previewTokens = new Map<string, PreviewEntry>()

function pruneExpired(now = Date.now()): void {
  for (const [token, entry] of previewTokens) {
    if (entry.expiresAt <= now) previewTokens.delete(token)
  }
}

export function createPreviewUrl(workspace: string, filePath: string, mime: string): string {
  pruneExpired()
  while (previewTokens.size >= MAX_TOKENS) {
    const oldest = previewTokens.keys().next().value
    if (!oldest) break
    previewTokens.delete(oldest)
  }
  const token = randomBytes(18).toString('base64url')
  previewTokens.set(token, { workspace, filePath, mime, expiresAt: Date.now() + TOKEN_TTL_MS })
  return `${PREVIEW_ORIGIN}/${token}`
}

export function resolvePreviewToken(token: string): PreviewEntry | null {
  const entry = previewTokens.get(token)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    previewTokens.delete(token)
    return null
  }
  return entry
}

export function resetPreviewTokensForTest(): void {
  previewTokens.clear()
}

export function describeFilePreview(workspace: string, inputPath: string): FilePreviewMeta {
  const stat = statWorkspaceFile(workspace, inputPath)
  if (stat.kind !== 'file') throw new Error('这是一个文件夹，不能预览。')

  const name = basename(stat.absolutePath)
  const detected = binaryPreviewKindForFileName(name)
  let kind: FilePreviewKind = detected ?? 'unsupported'
  let note: string | undefined

  if (kind === 'image' && stat.size > IMAGE_PREVIEW_MAX_BYTES) {
    kind = 'unsupported'
    note = `图片有 ${formatBytes(stat.size)}，超过 ${formatBytes(IMAGE_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
  } else if (kind === 'pdf' && stat.size > PDF_PREVIEW_MAX_BYTES) {
    kind = 'unsupported'
    note = `PDF 有 ${formatBytes(stat.size)}，超过 ${formatBytes(PDF_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
  } else if (kind === 'docx' && stat.size > DOCX_PREVIEW_MAX_BYTES) {
    kind = 'unsupported'
    note = `Word 文档有 ${formatBytes(stat.size)}，超过 ${formatBytes(DOCX_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
  } else if ((kind === 'xlsx' || kind === 'pptx' || kind === 'document') && stat.size > OFFICE_PREVIEW_MAX_BYTES) {
    const label = kind === 'xlsx' ? 'Excel 表格' : kind === 'pptx' ? 'PowerPoint 演示文稿' : '文档'
    kind = 'unsupported'
    note = `${label}有 ${formatBytes(stat.size)}，超过 ${formatBytes(OFFICE_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
  } else if (kind === 'archive' && stat.size > ARCHIVE_PREVIEW_MAX_BYTES) {
    kind = 'unsupported'
    note = `压缩包有 ${formatBytes(stat.size)}，超过 ${formatBytes(ARCHIVE_PREVIEW_MAX_BYTES)} 的列表上限。请用系统应用打开。`
  } else if (kind === 'unsupported') {
    if (isTextFileName(name)) {
      note = '文本文件请用编辑器打开。'
    } else if (isLegacyOfficeFileName(name)) {
      note = '旧版 Office 二进制格式（.doc/.xls/.ppt）无法内联解析；请用系统应用打开，或另存为 docx/xlsx/pptx。'
    } else if (/^(?:7z|rar|tar|gz|bz2|xz|tgz)$/i.test(name.split('.').pop() ?? '')) {
      note = '这种压缩格式暂不支持在线列表；请用系统应用打开。ZIP/JAR 可直接预览。'
    } else if (/^\.(?:psd|ai|sketch|fig|dwg|indd|epub)$/i.test(name)) {
      note = '这种专业设计/电子书格式暂不支持在线预览；请用系统应用打开。'
    } else {
      note = '这种文件格式暂不支持在 Morrow 内预览，可以用系统应用打开。'
    }
  }

  const mime = mimeTypeForFileName(name)
  const url =
    mime && (kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video')
      ? createPreviewUrl(workspace, stat.absolutePath, mime)
      : undefined

  return {
    path: stat.path,
    absolutePath: stat.absolutePath,
    kind,
    mime,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ...(url ? { url } : {}),
    ...(note ? { note } : {})
  }
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Cross-Origin-Resource-Policy': 'cross-origin'
}

function errorResponse(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: {
      ...CORS_HEADERS,
      ...extra,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

interface ByteRange {
  start: number
  end: number
}

function parseRange(value: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null
  let start: number
  let end: number
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
    if (start < 0 || start >= size || end < start) return null
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

export async function handlePreviewProtocol(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, '只允许读取预览文件。', { Allow: 'GET, HEAD, OPTIONS' })
  }

  let parsed: URL
  try {
    parsed = new URL(request.url)
  } catch {
    return errorResponse(400, '预览地址不合法。')
  }
  if (parsed.protocol !== 'morrow-file:' || parsed.hostname !== 'preview') {
    return errorResponse(404, '预览不存在。')
  }
  const token = parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
  const entry = resolvePreviewToken(token)
  if (!entry) return errorResponse(404, '预览链接已过期，请重新打开文件。')

  let stat
  try {
    // 每次请求都重新校验工作区边界，防止令牌签发后文件被替换为指向外部的链接。
    stat = statWorkspaceFile(entry.workspace, entry.filePath)
  } catch {
    return errorResponse(404, '文件已经不存在或不再允许预览。')
  }
  if (stat.kind !== 'file') return errorResponse(404, '这不是一个可预览的文件。')
  const filePath = stat.absolutePath

  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    'Content-Type': entry.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }

  const rangeHeader = request.headers.get('range')
  if (!rangeHeader) {
    headers['Content-Length'] = String(stat.size)
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    const stream = createReadStream(filePath)
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers })
  }

  const range = parseRange(rangeHeader, stat.size)
  if (!range) {
    return errorResponse(416, '请求的文件范围不合法。', { 'Content-Range': `bytes */${stat.size}` })
  }
  const length = range.end - range.start + 1
  headers['Content-Length'] = String(length)
  headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
  if (request.method === 'HEAD') return new Response(null, { status: 206, headers })
  const stream = createReadStream(filePath, { start: range.start, end: range.end })
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 206, headers })
}

const MAX_XML_TEXT_BYTES = 32 * 1024 * 1024

const MAX_OUTPUT_HTML_BYTES = 6 * 1024 * 1024

const MAX_SHEETS = 10

const MAX_ROWS = 200

const MAX_COLS = 30

const MAX_CELL_CHARS = 400

const MAX_SLIDES = 80

const MAX_LINES_PER_SLIDE = 40

const MAX_DOC_PARAGRAPHS = 3000

const MAX_ARCHIVE_ENTRIES = 2000

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

function stripTags(xml: string): string {
  return decodeXml(xml.replace(/<[^>]*>/g, ''))
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const regex = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (let match = regex.exec(tag); match; match = regex.exec(tag)) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '')
  }
  return attributes
}

function assertFile(workspace: string, inputPath: string, extensions: string[]): {
  absolutePath: string
  size: number
  mtimeMs: number
  name: string
} {
  const stat = statWorkspaceFile(workspace, inputPath)
  if (stat.kind !== 'file') throw new Error('这是一个文件夹，不能预览。')
  const ext = extname(stat.absolutePath).slice(1).toLowerCase()
  if (!extensions.includes(ext)) {
    throw new Error(`不支持的文件类型：.${ext || '未知'}。`)
  }
  if (stat.size > OFFICE_PREVIEW_MAX_BYTES) {
    throw new Error(
      `文件有 ${formatBytes(stat.size)}，超过 ${formatBytes(OFFICE_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
    )
  }
  return {
    absolutePath: stat.absolutePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    name: basename(stat.absolutePath)
  }
}

async function loadZip(absolutePath: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(readFileSync(absolutePath))
  } catch {
    throw new Error('文件不是有效的 ZIP/OOXML 包，可能已损坏。')
  }
}

async function readZipText(zip: JSZip, entry: string): Promise<string | null> {
  const file = zip.file(entry)
  if (!file) return null
  const text = await file.async('string')
  return text.length > MAX_XML_TEXT_BYTES ? text.slice(0, MAX_XML_TEXT_BYTES) : text
}

function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/i.exec(ref)?.[1] ?? ''
  let index = 0
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64)
  return Math.max(0, index - 1)
}

function normalizeZipTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  if (target.startsWith('xl/')) return target
  return `xl/${target.replace(/^\.\//, '')}`
}

async function parseSheetRows(xml: string, shared: string[]): Promise<{ rows: string[][]; truncated: boolean }> {
  const rows: string[][] = []
  let truncated = false
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  for (let rowMatch = rowRegex.exec(xml); rowMatch; rowMatch = rowRegex.exec(xml)) {
    if (rows.length >= MAX_ROWS) {
      truncated = true
      break
    }
    const cells: string[] = []
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    for (let cellMatch = cellRegex.exec(rowMatch[1]); cellMatch; cellMatch = cellRegex.exec(rowMatch[1])) {
      const attrs = parseAttributes(cellMatch[1])
      const body = cellMatch[2] ?? ''
      const col = attrs.r ? columnIndex(attrs.r) : cells.length
      if (col >= MAX_COLS) {
        truncated = true
        continue
      }
      while (cells.length < col) cells.push('')
      const type = attrs.t ?? ''
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''
      let text = ''
      if (type === 's') {
        text = shared[Number(value)] ?? ''
      } else if (type === 'inlineStr') {
        text = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1])).join('')
      } else if (type === 'b') {
        text = value === '1' ? 'TRUE' : 'FALSE'
      } else if (type === 'e') {
        text = '#ERROR'
      } else {
        text = decodeXml(value)
      }
      text = text.replace(/\r\n/g, '\n').slice(0, MAX_CELL_CHARS)
      if (cells.length > MAX_COLS) {
        truncated = true
        break
      }
      cells[col] = text
    }
    rows.push(cells)
  }
  return { rows, truncated }
}

export async function convertXlsxToPreview(workspace: string, inputPath: string): Promise<XlsxPreviewResult> {
  const file = assertFile(workspace, inputPath, ['xlsx', 'xlsm', 'xltx', 'xltm'])
  const zip = await loadZip(file.absolutePath)
  const workbook = (await readZipText(zip, 'xl/workbook.xml')) ?? ''
  const relsXml = (await readZipText(zip, 'xl/_rels/workbook.xml.rels')) ?? ''
  const rels = new Map<string, string>()
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const attrs = parseAttributes(match[0])
    if (attrs.Id && attrs.Target) rels.set(attrs.Id, normalizeZipTarget(attrs.Target.replace(/\\/g, '/')))
  }
  const sheetDefs: Array<{ name: string; target: string }> = []
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const attrs = parseAttributes(match[0])
    if (!attrs.name) continue
    const rid = attrs['r:id'] ?? attrs.id ?? ''
    const target = rels.get(rid) ?? `xl/worksheets/sheet${sheetDefs.length + 1}.xml`
    sheetDefs.push({ name: attrs.name, target })
  }
  if (sheetDefs.length === 0) sheetDefs.push({ name: 'Sheet1', target: 'xl/worksheets/sheet1.xml' })

  const sharedXml = (await readZipText(zip, 'xl/sharedStrings.xml')) ?? ''
  const shared: string[] = []
  for (const match of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push([...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((item) => decodeXml(item[1])).join(''))
    if (shared.length > 20_000) break
  }

  const warnings: string[] = []
  const sheets: XlsxSheetPreview[] = []
  for (const definition of sheetDefs.slice(0, MAX_SHEETS)) {
    const xml = await readZipText(zip, definition.target)
    if (!xml) {
      warnings.push(`工作表「${definition.name}」读取失败，已跳过。`)
      continue
    }
    const parsed = await parseSheetRows(xml, shared)
    sheets.push({ name: definition.name, rows: parsed.rows, truncated: parsed.truncated })
  }
  if (sheetDefs.length > MAX_SHEETS) warnings.push(`工作簿包含 ${sheetDefs.length} 个工作表，仅显示前 ${MAX_SHEETS} 个。`)
  if (sheets.length === 0) warnings.push('没有解析到可显示的工作表。')
  return { sheets, warnings, size: file.size, mtimeMs: file.mtimeMs }
}

function slideNumber(path: string): number {
  return Number(/slide(\d+)\.xml$/i.exec(path)?.[1] ?? 0)
}

export async function convertPptxToPreview(workspace: string, inputPath: string): Promise<PptxPreviewResult> {
  const file = assertFile(workspace, inputPath, ['pptx', 'pptm', 'ppsx', 'potx'])
  const zip = await loadZip(file.absolutePath)
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  const warnings: string[] = []
  const slides: PptxSlidePreview[] = []
  for (const path of slidePaths.slice(0, MAX_SLIDES)) {
    const xml = await readZipText(zip, path)
    if (!xml) continue
    const paragraphs: string[] = []
    for (const match of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
      const text = [...match[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((item) => decodeXml(item[1]))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) paragraphs.push(text)
    }
    if (paragraphs.length === 0) continue
    slides.push({
      index: slideNumber(path) || slides.length + 1,
      title: paragraphs[0].slice(0, 200),
      lines: paragraphs.slice(1, MAX_LINES_PER_SLIDE + 1).map((line) => line.slice(0, 500))
    })
  }
  if (slidePaths.length > MAX_SLIDES) warnings.push(`演示文稿包含 ${slidePaths.length} 页，仅显示前 ${MAX_SLIDES} 页。`)
  if (slides.length === 0) warnings.push('没有从幻灯片中提取到文本内容（可能全部是图片或形状）。')
  return { slides, warnings, size: file.size, mtimeMs: file.mtimeMs }
}

function paragraphsToHtml(paragraphs: string[], title?: string): string {
  const body = paragraphs.slice(0, MAX_DOC_PARAGRAPHS).map((paragraph) => {
    const text = paragraph.trim()
    if (!text) return ''
    if (/^#{1,3}\s/.test(text)) return `<h2>${escapeHtml(text.replace(/^#{1,3}\s/, ''))}</h2>`
    return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`
  })
  return `${title ? `<h1>${escapeHtml(title)}</h1>` : ''}${body.join('\n')}`
}

function decodeRtf(raw: string): string {
  let text = raw
  // 丢弃字体/颜色/样式表、图片等声明组；不能吞掉整个 RTF 根组
  text = text.replace(/\{\\\*[^{}]*\}/g, '')
  text = text.replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|pict|object|header|footer)[^{}]*\}/g, '')
  text = text.replace(/\\u(-?\d+)\??/g, (_, code: string) => String.fromCharCode(((Number(code) % 65536) + 65536) % 65536))
  text = text.replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  text = text.replace(/\\par[d]?\b/g, '\n\n').replace(/\\line\b/g, '\n').replace(/\\tab\b/g, '\t')
  text = text.replace(/\\[a-z]+-?\d* ?/gi, '')
  text = text.replace(/[{}]/g, '')
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function odfParagraphs(xml: string): string[] {
  const paragraphs: string[] = []
  const regex = /<text:(p|h)\b[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g
  for (let match = regex.exec(xml); match; match = regex.exec(xml)) {
    const text = stripTags(match[2]).replace(/\s+\n/g, '\n').trim()
    if (text) paragraphs.push(match[1] === 'h' ? `## ${text}` : text)
  }
  return paragraphs
}

function odsTablesToHtml(xml: string): string {
  const tables: string[] = []
  for (const tableMatch of xml.matchAll(/<table:table\b[^>]*>([\s\S]*?)<\/table:table>/g)) {
    const rows: string[] = []
    for (const rowMatch of tableMatch[1].matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
      if (rows.length >= MAX_ROWS) break
      const cells: string[] = []
      for (const cellMatch of rowMatch[1].matchAll(/<table:table-cell\b[^>]*>([\s\S]*?)<\/table:table-cell>/g)) {
        if (cells.length >= MAX_COLS) break
        cells.push(escapeHtml(odfParagraphs(cellMatch[1]).join(' ')).slice(0, MAX_CELL_CHARS))
      }
      if (cells.length) rows.push(`<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    }
    if (rows.length) tables.push(`<table>${rows.join('')}</table>`)
  }
  return tables.join('\n')
}

async function epubHtml(zip: JSZip): Promise<{ html: string; warnings: string[] }> {
  const warnings: string[] = []
  const container = (await readZipText(zip, 'META-INF/container.xml')) ?? ''
  const rootPath = /full-path="([^"]+)"/i.exec(container)?.[1]
  if (!rootPath) return { html: '', warnings: ['没有找到 EPUB 的 container.xml，无法解析目录。'] }
  const opf = (await readZipText(zip, rootPath)) ?? ''
  const base = rootPath.includes('/') ? rootPath.slice(0, rootPath.lastIndexOf('/') + 1) : ''
  const manifest = new Map<string, string>()
  for (const match of opf.matchAll(/<item\b[^>]*>/g)) {
    const attrs = parseAttributes(match[0])
    if (attrs.id && attrs.href) manifest.set(attrs.id, attrs.href)
  }
  const spine: string[] = []
  for (const match of opf.matchAll(/<itemref\b[^>]*>/g)) {
    const attrs = parseAttributes(match[0])
    const href = attrs.idref ? manifest.get(attrs.idref) : undefined
    if (href) spine.push(href)
  }
  const sections: string[] = []
  for (const href of spine.slice(0, 40)) {
    const path = decodeURIComponent(href.startsWith('/') ? href.slice(1) : `${base}${href}`)
    const xhtml = await readZipText(zip, path)
    if (!xhtml) continue
    const blocks: string[] = []
    for (const match of xhtml.matchAll(/<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const text = stripTags(match[2]).replace(/\s+/g, ' ').trim()
      if (!text) continue
      if (match[1].toLowerCase().startsWith('h')) blocks.push(`<h2>${escapeHtml(text)}</h2>`)
      else if (match[1].toLowerCase() === 'li') blocks.push(`<p>• ${escapeHtml(text)}</p>`)
      else blocks.push(`<p>${escapeHtml(text)}</p>`)
    }
    if (blocks.length) sections.push(`<section>${blocks.join('\n')}</section>`)
  }
  if (spine.length > 40) warnings.push(`EPUB 包含 ${spine.length} 个章节，仅显示前 40 个。`)
  if (sections.length === 0) warnings.push('没有从 EPUB 中提取到可读正文。')
  return { html: sections.join('\n<hr>\n'), warnings }
}

export async function convertDocumentToPreview(workspace: string, inputPath: string): Promise<DocumentPreviewResult> {
  const file = assertFile(workspace, inputPath, ['rtf', 'odt', 'ods', 'odp', 'epub'])
  const ext = extname(file.name).slice(1).toLowerCase()
  const warnings: string[] = []
  let html = ''
  let format = ext.toUpperCase()
  if (ext === 'rtf') {
    const raw = readFileSync(file.absolutePath, 'utf8')
    html = paragraphsToHtml(decodeRtf(raw).split(/\n{2,}/))
    format = 'RTF'
  } else {
    const zip = await loadZip(file.absolutePath)
    if (ext === 'epub') {
      const result = await epubHtml(zip)
      html = result.html
      warnings.push(...result.warnings)
      format = 'EPUB'
    } else {
      const xml = (await readZipText(zip, 'content.xml')) ?? ''
      if (ext === 'ods') {
        html = odsTablesToHtml(xml)
        format = 'ODS'
      } else {
        const paragraphs = odfParagraphs(xml)
        html = paragraphsToHtml(paragraphs)
        format = ext === 'odt' ? 'ODT' : 'ODP'
      }
      if (!xml) warnings.push('没有找到 content.xml，文档可能已损坏。')
    }
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_OUTPUT_HTML_BYTES) {
    // 按 UTF-8 字节截断，而不是字符数（CJK 下字符数会放大到约 3 倍）
    let end = Math.min(html.length, MAX_OUTPUT_HTML_BYTES)
    while (end > 1024 && Buffer.byteLength(html.slice(0, end), 'utf8') > MAX_OUTPUT_HTML_BYTES) {
      end = Math.floor(end * 0.9)
    }
    html = `${html.slice(0, end)}<p>…（预览已截断）</p>`
    warnings.push('文档内容过长，预览已截断。')
  }
  if (!html.trim()) warnings.push('没有从文档中提取到可读正文。')
  return { html, format, warnings, size: file.size, mtimeMs: file.mtimeMs }
}

export async function listArchive(workspace: string, inputPath: string): Promise<ArchivePreviewResult> {
  const stat = statWorkspaceFile(workspace, inputPath)
  if (stat.kind !== 'file') throw new Error('这是一个文件夹，不能预览。')
  const ext = extname(stat.absolutePath).slice(1).toLowerCase()
  if (!['zip', 'jar', 'whl', 'vsix'].includes(ext)) {
    throw new Error('目前支持在线列出 ZIP/JAR/WHL/VSIX；其他压缩格式请用系统应用打开。')
  }
  if (stat.size > ARCHIVE_PREVIEW_MAX_BYTES) {
    throw new Error(
      `压缩包有 ${formatBytes(stat.size)}，超过 ${formatBytes(ARCHIVE_PREVIEW_MAX_BYTES)} 的列表上限。请用系统应用打开。`
    )
  }
  const zip = await loadZip(stat.absolutePath)
  const all = Object.values(zip.files)
  const entries: ArchiveEntryPreview[] = []
  for (const entry of all.slice(0, MAX_ARCHIVE_ENTRIES)) {
    const data = (entry as unknown as { _data?: { uncompressedSize?: number; compressedSize?: number } })._data
    entries.push({
      name: entry.name,
      dir: entry.dir,
      size: typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : 0,
      compressedSize: typeof data?.compressedSize === 'number' ? data.compressedSize : 0,
      date: entry.date instanceof Date && !Number.isNaN(entry.date.getTime()) ? entry.date.toISOString() : null
    })
  }
  return {
    entries,
    total: all.length,
    truncated: all.length > MAX_ARCHIVE_ENTRIES,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  }
}

const MAX_DOCX_HTML_BYTES = 30 * 1024 * 1024

export interface DocxPreviewResult {
  html: string
  size: number
  mtimeMs: number
  warnings: string[]
}

/** DOCX → 只读 HTML；图片内联为 data URI，输出体量有上限。 */
export async function convertDocxToHtml(workspace: string, inputPath: string): Promise<DocxPreviewResult> {
  const stat = statWorkspaceFile(workspace, inputPath)
  if (stat.kind !== 'file') throw new Error('这是一个文件夹，不能预览。')
  if (extname(stat.absolutePath).toLowerCase() !== '.docx') throw new Error('只支持 .docx 文档预览。')
  if (stat.size > DOCX_PREVIEW_MAX_BYTES) {
    throw new Error(
      `Word 文档有 ${formatBytes(stat.size)}，超过 ${formatBytes(DOCX_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
    )
  }

  const result = await mammoth.convertToHtml(
    { buffer: readFileSync(stat.absolutePath) },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const base64 = await image.readAsBase64String()
        return { src: `data:${image.contentType};base64,${base64}` }
      })
    }
  )
  if (Buffer.byteLength(result.value, 'utf8') > MAX_DOCX_HTML_BYTES) {
    throw new Error(
      `「${basename(stat.absolutePath)}」转换后的内容过大（超过 ${formatBytes(MAX_DOCX_HTML_BYTES)}），请用系统应用打开。`
    )
  }

  return {
    html: result.value,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    warnings: result.messages.filter((message) => message.type === 'warning').map((message) => message.message)
  }
}

const OCR_TIMEOUT_MS = 180_000

const MAX_STDERR_CHARS = 16_000

/** 通过 base64 内存流交给系统 OCR；超大 PDF 建议先拆分 */
const MAX_OCR_PDF_BYTES = 40 * 1024 * 1024

/** 去掉中文 OCR 常见的逐字空格，并把被误识别的间隔号还原为标点。 */
export function normalizeOcrText(text: string): string {
  if (!text) return ''
  let out = text.replace(/\r\n?/g, '\n')
  // 行首的 OCR 项目符号不是正文
  out = out
    .split('\n')
    .map((line) => line.replace(/^[ \t]*[·•・][ \t]*/, '').replace(/[ \t]+/g, ' ').trim())
    .join('\n')
  return out
    .replace(/(\d)\s*[·•・]\s*(\d)/g, '$1.$2')
    .replace(/([\u3400-\u9fff])\s*[·•・]\s*(?=\n|$)/g, '$1：')
    .replace(/([A-Za-z0-9])\s*[·•・]\s*(?=[A-Za-z0-9])/g, '$1 ')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fffA-Za-z0-9])/g, '$1')
    .replace(/([\u3400-\u9fff])\s*([：，。！？；、）】》”’])/g, '$1$2')
    .replace(/([：，。！？；、])\s+(?=[\u3400-\u9fffA-Za-z0-9])/g, '$1')
    .replace(/([（【《“‘])\s*([\u3400-\u9fff])/g, '$1$2')
    .replace(/(\d)\s*、\s*(?=\d)/g, '$1、')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function scriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'pdf-ocr.ps1')
    : join(app.getAppPath(), 'resources', 'pdf-ocr.ps1')
}

function runPowerShell(args: string[], signal?: AbortSignal): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      try {
        child.kill()
      } catch {
      }
      finish(() => reject(new Error('PDF OCR 已取消。')))
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
      }
      finish(() => reject(new Error('PDF OCR 超时，请缩小 pages 范围后重试。')))
    }, OCR_TIMEOUT_MS)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      finish(() => reject(new Error(`无法启动本机 OCR（${err.message}）。`)))
    })
    child.on('close', (code) => {
      finish(() => resolve({ code: code ?? 1, stderr: stderr.trim() }))
    })
  })
}

/** 创建主进程 OCR handler；每次调用使用独立的临时输出文件。 */
export function createPdfOcrHandler(): PdfOcrHandler {
  return async (request): Promise<PdfOcrResult> => {
    if (process.platform !== 'win32') {
      throw new Error('扫描版 PDF 的本机 OCR 目前只支持 Windows。')
    }
    const script = scriptPath()
    if (!existsSync(script)) throw new Error('本机 OCR 脚本缺失，请重新安装或重新解压完整版本。')
    if (!Array.isArray(request.pages) || request.pages.length === 0) {
      throw new Error('没有指定要识别的页码。')
    }
    const pages = [...new Set(request.pages.filter((page) => Number.isInteger(page) && page >= 1))].slice(0, 24)
    if (pages.length === 0) throw new Error('没有指定有效的页码。')

    // 放在应用数据目录的 tmp 下：受限进程/便携版都能写，且不会把扫描件留在系统临时目录。
    const baseDir = dataPath('tmp')
    mkdirSync(baseDir, { recursive: true })
    const tempDir = mkdtempSync(join(baseDir, 'ocr-'))
    const outPath = join(tempDir, 'result.json')
    const inputPath = join(tempDir, 'input.b64')
    try {
      const pdfBytes = readFileSync(request.path)
      if (pdfBytes.byteLength > MAX_OCR_PDF_BYTES) {
        throw new Error(
          `扫描件过大（${Math.round(pdfBytes.byteLength / 1024 / 1024)}MB），本机 OCR 单次最多 40MB；请先拆分 PDF 或只提供关键页。`
        )
      }
      writeFileSync(inputPath, pdfBytes.toString('base64'), 'utf8')
      const { code, stderr } = await runPowerShell(
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-InputPath',
          inputPath,
          '-Pages',
          pages.join(','),
          '-OutPath',
          outPath
        ],
        request.signal
      )
      if (!existsSync(outPath)) {
        throw new Error(
          `本机 OCR 没有返回结果（退出码 ${code}）${stderr ? `：${stderr.slice(0, 300)}` : '。'}`
        )
      }
      const raw = JSON.parse(readFileSync(outPath, 'utf8')) as {
        error?: unknown
        totalPages?: unknown
        language?: unknown
        engine?: unknown
        pages?: unknown
      }
      if (typeof raw.error === 'string' && raw.error.trim()) throw new Error(raw.error.trim())
      const resultPages = Array.isArray(raw.pages)
        ? raw.pages
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
            .map((item) => ({
              page: typeof item.page === 'number' ? item.page : 0,
              text: normalizeOcrText(typeof item.text === 'string' ? item.text : ''),
              ...(typeof item.error === 'string' && item.error ? { error: item.error.slice(0, 300) } : {})
            }))
            .filter((item) => item.page > 0)
        : []
      const result: PdfOcrResult = {
        totalPages: typeof raw.totalPages === 'number' ? raw.totalPages : 0,
        language: typeof raw.language === 'string' ? raw.language : '',
        engine: typeof raw.engine === 'string' ? raw.engine : 'Windows.Media.Ocr',
        pages: resultPages
      }
      log.info('pdf ocr finished', {
        pages: pages.length,
        language: result.language,
        failed: resultPages.filter((page) => page.error).length
      })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/^PDF OCR (超时|已取消)/.test(message)) throw err
      throw new Error(`本机 OCR 失败：${message}`)
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
      }
    }
  }
}

export const MAX_VERSIONS_PER_FILE = 30

/** 单个版本内容上限：超过则不记录（避免把大文件/二进制塞进历史） */
export const MAX_VERSION_BYTES = 2 * 1024 * 1024

/** 全库容量上限 */
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024

export type HistorySource = 'user' | 'agent' | 'baseline' | 'restore'

export interface HistoryVersion {
  /** 版本 id（也用于内容文件名） */
  id: string
  /** 规范化后的文件路径（展示原始路径） */
  path: string
  /** 用户看到的文件名 */
  name: string
  createdAt: number
  source: HistorySource
  size: number
  /** 内容 sha256（去重/校验用） */
  contentHash: string
  /** 记录时文件 mtime（restore 冲突检测用，可缺省） */
  mtimeMs?: number
  label?: string
}

export interface HistoryRecordInput {
  path: string
  content: string
  source?: HistorySource
  mtimeMs?: number
  label?: string
  /** 即使内容相同也强制记录一条 */
  force?: boolean
}

export interface HistoryRestoreResult {
  path: string
  versionId: string
  mtimeMs: number
  size: number
  /** 恢复动作本身也被记录为新版本（便于再次回退） */
  newVersionId: string | null
}

interface FileIndex {
  /** 原始路径（展示用，不参与 hash） */
  path: string
  name: string
  versions: HistoryVersion[]
}

/** 规范化路径：绝对路径 + Windows 大小写不敏感（hash 用） */
export function canonicalPath(filePath: string): string {
  const resolved = resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function pathKey(filePath: string): string {
  return createHash('sha256').update(canonicalPath(filePath)).digest('hex').slice(0, 24)
}

function searchSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function safeReadJson(file: string): FileIndex | null {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as FileIndex
    if (!parsed || !Array.isArray(parsed.versions)) return null
    return parsed
  } catch {
    return null
  }
}

function safeWriteFile(file: string, content: string): void {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameWithRetry(tmp, file)
}

export interface EditorHistoryOptions {
  maxVersionsPerFile?: number
  maxTotalBytes?: number
  maxVersionBytes?: number
}

export class EditorHistoryStore {
  private readonly root: string
  private readonly maxVersions: number
  private readonly maxTotalBytes: number
  private readonly maxVersionBytes: number

  constructor(rootDir: string, options: EditorHistoryOptions = {}) {
    this.root = resolve(rootDir)
    this.maxVersions = options.maxVersionsPerFile ?? MAX_VERSIONS_PER_FILE
    this.maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES
    this.maxVersionBytes = options.maxVersionBytes ?? MAX_VERSION_BYTES
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true })
  }

  private fileDir(filePath: string): string {
    return join(this.root, pathKey(filePath))
  }

  private indexPath(filePath: string): string {
    return join(this.fileDir(filePath), 'versions.json')
  }

  private readIndex(filePath: string): FileIndex {
    const index = safeReadJson(this.indexPath(filePath))
    if (index) return index
    const name = basename(filePath)
    return { path: resolve(filePath), name, versions: [] }
  }

  private writeIndex(filePath: string, index: FileIndex): void {
    safeWriteFile(this.indexPath(filePath), JSON.stringify(index, null, 2))
  }

  /** 记录一个版本；内容过大返回 null，内容与最新版本相同时（非 force）返回已有版本。 */
  record(input: HistoryRecordInput): HistoryVersion | null {
    const filePath = resolve(input.path)
    if (!filePath) throw new Error('缺少文件路径，无法记录版本')
    const content = typeof input.content === 'string' ? input.content : ''
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.maxVersionBytes) return null

    const hash = searchSha256(content)
    const index = this.readIndex(filePath)
    const latest = index.versions[0]
    if (!input.force && latest && latest.contentHash === hash) return latest

    const createdAt = Date.now()
    const id = `v${createdAt.toString(36)}-${randomBytes(3).toString('hex')}`
    const version: HistoryVersion = {
      id,
      path: index.path,
      name: index.name,
      createdAt,
      source: input.source ?? 'user',
      size: bytes,
      contentHash: hash,
      ...(typeof input.mtimeMs === 'number' ? { mtimeMs: Math.round(input.mtimeMs) } : {}),
      ...(input.label ? { label: input.label } : {})
    }
    safeWriteFile(join(this.fileDir(filePath), `${id}.txt`), content)
    index.versions = [version, ...index.versions].slice(0, this.maxVersions)
    this.writeIndex(filePath, index)
    // 被裁掉的版本清掉内容文件
    const kept = new Set(index.versions.map((item) => item.id))
    for (const stale of readdirSync(this.fileDir(filePath))) {
      if (stale === 'versions.json' || kept.has(stale.replace(/\.txt$/, ''))) continue
      try {
        unlinkSync(join(this.fileDir(filePath), stale))
      } catch {
        // 清理失败不影响主流程
      }
    }
    this.pruneTotal()
    return version
  }

  /** 版本列表（最新在前），不返回内容。 */
  list(filePath: string): { path: string; versions: HistoryVersion[] } {
    const index = this.readIndex(filePath)
    return { path: index.path, versions: index.versions }
  }

  /** 读取某个版本内容；版本不存在返回 null。 */
  read(filePath: string, versionId: string): { version: HistoryVersion; content: string } | null {
    const index = this.readIndex(filePath)
    const version = index.versions.find((item) => item.id === versionId)
    if (!version) return null
    const contentPath = join(this.fileDir(filePath), `${version.id}.txt`)
    if (!existsSync(contentPath)) return null
    return { version, content: readFileSync(contentPath, 'utf8') }
  }

  /**
   * 某个版本与目标文本（通常是编辑器当前内容）或上一个版本的 unified diff。
   * 目标未提供时与更旧一个版本比较；没有更旧版本则与空文本比较。
   */
  diff(filePath: string, versionId: string, targetContent?: string): (DiffResult & { version: HistoryVersion; targetLabel: string }) | null {
    const index = this.readIndex(filePath)
    const versionIndex = index.versions.findIndex((item) => item.id === versionId)
    if (versionIndex < 0) return null
    const current = this.read(filePath, versionId)
    if (!current) return null
    let target = targetContent
    let targetLabel = '当前内容'
    if (typeof target !== 'string') {
      // 选中项不是最新版：与最新版比较（看这个版本之后改了什么）；
      // 选中项本身就是最新版：与上一版比较（看这一版改了什么）。
      const base = versionIndex === 0 ? index.versions[1] : index.versions[0]
      const baseContent = base ? this.read(filePath, base.id) : null
      target = baseContent?.content ?? ''
      targetLabel = base
        ? versionIndex === 0
          ? `上一版本 ${new Date(base.createdAt).toLocaleString('zh-CN')}`
          : `最新版本 ${new Date(base.createdAt).toLocaleString('zh-CN')}`
        : '空文件'
    }
    const result = createUnifiedDiff(current.content, target, basename(filePath))
    return { ...result, version: current.version, targetLabel }
  }

  /**
   * 恢复某个版本内容到磁盘。
   * - 只允许恢复本服务记录过历史的路径（防任意写）；
   * - expectedMtimeMs 与文件当前 mtime 不一致时抛错（外部修改冲突）；
   * - 恢复本身会记录为新版本，方便再次回退。
   */
  restore(filePath: string, versionId: string, options: { expectedMtimeMs?: number; source?: HistorySource } = {}): HistoryRestoreResult {
    const target = resolve(filePath)
    const index = this.readIndex(target)
    const version = index.versions.find((item) => item.id === versionId)
    if (!version) throw new Error('找不到这个历史版本，可能已经被清理')
    const current = this.read(target, versionId)
    if (!current) throw new Error('这个历史版本的内容已丢失，无法恢复')

    if (existsSync(target)) {
      const stat = statSync(target)
      if (stat.isDirectory()) throw new Error('目标是一个文件夹，不能恢复为文件')
      if (typeof options.expectedMtimeMs === 'number') {
        const currentMtime = Math.round(stat.mtimeMs)
        if (Math.abs(currentMtime - Math.round(options.expectedMtimeMs)) > 1) {
          throw new Error('文件在版本恢复前被外部修改过，请先重新加载再恢复')
        }
      }
    } else {
      if (!existsSync(dirname(target))) throw new Error('目标文件所在文件夹不存在')
    }

    const content = current.content
    const fileDir = dirname(target)
    if (!existsSync(fileDir)) mkdirSync(fileDir, { recursive: true })
    const tmp = join(fileDir, `.${basename(target)}.morrow-restore-${process.pid}.tmp`)
    writeFileSync(tmp, content, 'utf8')
    renameWithRetry(tmp, target)
    const nextStat = statSync(target)
    const recorded = this.record({
      path: target,
      content,
      source: options.source ?? 'restore',
      mtimeMs: nextStat.mtimeMs,
      label: `恢复 ${version.id}`,
      // 即使内容与已有版本相同，也记录一条「恢复」动作，便于审计与再次回退
      force: true
    })
    return {
      path: target,
      versionId,
      mtimeMs: Math.round(nextStat.mtimeMs),
      size: nextStat.size,
      newVersionId: recorded?.id ?? null
    }
  }

  /** 清空某个文件的全部历史（UI 未使用，供维护/测试） */
  clear(filePath: string): void {
    const dir = this.fileDir(filePath)
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      try {
        unlinkSync(join(dir, name))
      } catch {
      }
    }
  }

  /** 统计（测试/调试用） */
  stats(): { files: number; versions: number; bytes: number } {
    let files = 0
    let versions = 0
    let bytes = 0
    for (const dirName of readdirSync(this.root)) {
      const dir = join(this.root, dirName)
      if (!statSync(dir).isDirectory()) continue
      const index = safeReadJson(join(dir, 'versions.json'))
      if (!index) continue
      files += 1
      versions += index.versions.length
      for (const version of index.versions) bytes += version.size
    }
    return { files, versions, bytes }
  }

  /** 全库容量上限：按版本时间从旧到新删除，直到低于上限。 */
  private pruneTotal(): void {
    const entries: Array<{ file: string; dir: string; version: HistoryVersion }> = []
    for (const dirName of readdirSync(this.root)) {
      const dir = join(this.root, dirName)
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
      const index = safeReadJson(join(dir, 'versions.json'))
      if (!index || index.versions.length === 0) continue
      for (const version of index.versions) entries.push({ file: this.indexForDir(dir), dir, version })
    }
    let total = entries.reduce((sum, entry) => sum + entry.version.size, 0)
    if (total <= this.maxTotalBytes) return
    entries.sort((a, b) => a.version.createdAt - b.version.createdAt)
    const touched = new Set<string>()
    for (const entry of entries) {
      if (total <= this.maxTotalBytes) break
      if (touched.has(entry.file)) continue
      touched.add(entry.file)
      // 每个文件至少保留最新一版
      const index = safeReadJson(entry.file)
      if (!index || index.versions.length <= 1) continue
      const dropIds = new Set<string>()
      const sorted = [...index.versions].sort((a, b) => a.createdAt - b.createdAt)
      for (const candidate of sorted) {
        if (total <= this.maxTotalBytes) break
        if (index.versions.length - dropIds.size <= 1) break
        dropIds.add(candidate.id)
        total -= candidate.size
        try {
          unlinkSync(join(entry.dir, `${candidate.id}.txt`))
        } catch {
        }
      }
      index.versions = index.versions.filter((item) => !dropIds.has(item.id))
      safeWriteFile(entry.file, JSON.stringify(index, null, 2))
    }
  }

  private indexForDir(dir: string): string {
    return join(dir, 'versions.json')
  }
}

const IGNORE_DIRS = new Set(['node_modules', '.git', '.morrow', 'dist', 'out', 'release', 'tmp', '.cache'])

export async function pickWorkspace(): Promise<WorkspaceInfo | null> {
  const result = await dialog.showOpenDialog({
    title: '选择工作文件夹',
    buttonLabel: '让 Morrow 在这里工作',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return describeWorkspace(result.filePaths[0])
}

export function describeWorkspace(path: string): WorkspaceInfo {
  const resolved = resolve(path)
  const exists = existsSync(resolved) && statSync(resolved).isDirectory()
  let fileCount = 0
  if (exists) {
    try {
      const count = countFiles(resolved, 0)
      fileCount = count
    } catch {
      fileCount = 0
    }
  }
  return {
    path: resolved,
    name: basename(resolved),
    exists,
    fileCount,
    git: exists && existsSync(join(resolved, '.git'))
  }
}

function countFiles(dir: string, depth: number): number {
  if (depth > 4) return 0
  let total = 0
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (total > 2000) break
    if (name.startsWith('.') && name !== '.morrow') continue
    const full = join(dir, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      if (IGNORE_DIRS.has(name)) continue
      total += countFiles(full, depth + 1)
    } else {
      total += 1
    }
  }
  return total
}

/** 演示工作区固定位置；演示模型只允许在这里运行。 */
export function demoWorkspacePath(): string {
  return dataPath('demo-workspace')
}

/** 判断路径是否就是 Morrow 的演示工作区（不跟随前缀，避免把真实文件夹误认成演示区）。 */
export function isDemoWorkspace(path: string | null | undefined): boolean {
  if (!path) return false
  const canonical = (value: string): string => {
    const resolved = resolve(value)
    try {
      return realpathSync.native(resolved)
    } catch {
      return resolved
    }
  }
  try {
    const actual = canonical(path)
    const target = canonical(demoWorkspacePath())
    return process.platform === 'win32' ? actual.toLowerCase() === target.toLowerCase() : actual === target
  } catch {
    return false
  }
}

/** 把内置演示工作区复制到 userData/demo-workspace（只读源 assets/demo-workspace） */
export function createDemoWorkspace(): WorkspaceInfo {
  ensureDataDirs()
  const target = demoWorkspacePath()
  const source = join(app.getAppPath(), 'assets', 'demo-workspace')
  if (!existsSync(source)) {
    throw new Error('演示工作区资源缺失，请重新安装 Morrow。')
  }
  if (existsSync(target)) {
    removeTree(target)
  }
  mkdirSync(target, { recursive: true })
  copyTree(source, target)
  log.info('demo workspace prepared', { target })
  return describeWorkspace(target)
}

/** 在工作区内按文件名/路径模糊搜索（@ 引用） */
export function searchWorkspaceFiles(root: string, query: string, limit = 12): FileSearchResult[] {
  const base = resolve(root)
  if (!existsSync(base) || !statSync(base).isDirectory()) return []
  let baseReal: string
  try {
    baseReal = realpathSync(base)
  } catch {
    return []
  }
  const q = query.toLowerCase()
  const results: FileSearchResult[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || results.length > 400) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (results.length > 400) break
      if (name.startsWith('.') && name !== '.morrow') continue
      const full = join(dir, name)
      let stat
      try {
        // lstat + realpath：不跟随工作区内的符号链接/junction 逃逸到外部目录
        stat = lstatSync(full)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue
        try {
          if (!isPathInside(baseReal, realpathSync(full))) continue
        } catch {
          continue
        }
        walk(full, depth + 1)
        continue
      }
      const rel = full.slice(base.length + 1).replace(/\\/g, '/')
      const haystack = `${name.toLowerCase()} ${rel.toLowerCase()}`
      const score = scoreMatch(haystack, q)
      if (score > 0) {
        results.push({
          path: full,
          name,
          dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
          score
        })
      }
    }
  }
  walk(base, 0)
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

function scoreMatch(haystack: string, query: string): number {
  const index = haystack.indexOf(query)
  if (index === -1) {
    // 子序列匹配（fuzzy）
    let qi = 0
    for (let i = 0; i < haystack.length && qi < query.length; i++) {
      if (haystack[i] === query[qi]) qi += 1
    }
    return qi === query.length ? 1 : 0
  }
  return 100 - Math.min(50, index)
}

export async function readTextSafe(path: string, maxBytes = 512 * 1024): Promise<{ content: string; size: number; truncated: boolean }> {
  const stat = statSync(path)
  const size = stat.size
  if (size <= maxBytes) {
    return { content: readFileSync(path, 'utf8'), size, truncated: false }
  }
  // 只读取前 maxBytes，不把超大文件整份读进内存
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const read = readSync(fd, buffer, 0, maxBytes, 0)
    return { content: buffer.subarray(0, read).toString('utf8'), size, truncated: true }
  } finally {
    closeSync(fd)
  }
}

export function revealPath(path: string): void {
  void revealInFileManager(path)
}

/** 手写目录复制/删除：避免 Windows 上 fs.cpSync / rmSync 在特殊路径下的 EPERM */
function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source)) {
    const from = join(source, name)
    const to = join(target, name)
    const stat = statSync(from)
    if (stat.isDirectory()) copyTree(from, to)
    else writeFileSync(to, readFileSync(from))
  }
}

function removeTree(target: string): void {
  for (const name of readdirSync(target)) {
    const full = join(target, name)
    const stat = statSync(full)
    if (stat.isDirectory()) removeTree(full)
    else {
      const { unlinkSync } = require('node:fs') as typeof import('node:fs')
      unlinkSync(full)
    }
  }
  const { rmdirSync } = require('node:fs') as typeof import('node:fs')
  rmdirSync(target)
}

export type SearchHitKind = 'session' | 'file' | 'artifact'

export interface SearchHighlight {
  start: number
  end: number
}

export interface SearchHit {
  kind: SearchHitKind
  id: string
  title: string
  snippet: string
  highlights: SearchHighlight[]
  score: number
  /** 会话消息命中 */
  sessionId?: string
  messageId?: string
  role?: string
  /** 文件命中 */
  path?: string
  absolutePath?: string
  line?: number
  /** artifact 命中 */
  artifactId?: string
  artifactKind?: string
  updatedAt?: number
}

export interface SearchGroups {
  sessions: SearchHit[]
  files: SearchHit[]
  artifacts: SearchHit[]
}

export interface SearchIndexStatus {
  ready: boolean
  building: boolean
  sessions: number
  files: number
  artifacts: number
  workspaces: string[]
  lastBuiltAt?: number
}

export interface SearchResponse {
  query: string
  groups: SearchGroups
  total: number
  tookMs: number
  index: SearchIndexStatus
}

export interface SearchQueryInput {
  q: string
  /** 限定工作区；不传 = 搜索全部已索引工作区（全局） */
  workspace?: string | null
  limit?: number
}

export interface WorkspaceSearchServiceDeps {
  listSessions(): SessionMeta[]
  getSession(id: string): Session | null
  /** 用户最近/当前工作区（只索引这些，避免扫描无关磁盘） */
  listWorkspaces(): string[]
  /** 会话写入/删除版本；变化时绕过节流立即刷新会话索引 */
  getSessionRevision?: () => number
  /** 数据目录（Morrow Data 永不索引） */
  dataDir?: string
  now?: () => number
}

export interface WorkspaceSearchServiceOptions {
  /** 每个工作区最多索引文件数，默认 5000 */
  maxFilesPerWorkspace?: number
  /** 单文件最大索引字节，默认 512KB */
  maxFileBytes?: number
  /** 单条消息/artifact 最大索引字符，默认 20000 */
  maxTextChars?: number
  /** 查询自动刷新节流（毫秒），默认 1500 */
  autoRefreshMs?: number
}

interface SessionDoc {
  id: string
  title: string
  workspace: string | null
  updatedAt: number
  messages: Array<{ id: string; role: ChatMessage['role']; text: string }>
  artifacts: Array<{ artifact: Artifact; sessionTitle: string }>
}

interface FileDoc {
  absolutePath: string
  relPath: string
  name: string
  mtimeMs: number
  size: number
  text: string | null
  binary: boolean
}

const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', 'Morrow Data', 'out', 'release', 'dist', '.cache'])

const BINARY_PROBE_BYTES = 8192

/** 单个会话最多索引的正文字符数（优先保留最近的消息/成品，避免超长会话拖垮内存） */
export const SEARCH_SESSION_TEXT_BUDGET = 200_000

export const SEARCH_SESSION_ARTIFACT_BUDGET = 200_000

function normalizeWorkspaceOrNull(workspace: string | null | undefined): string | null {
  if (!workspace) return null
  return resolve(workspace)
}

function stripMarkup(text: string, kind?: string): string {
  if (kind === 'html' || kind === 'svg') {
    return text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  if (kind === 'markdown') {
    return text
      .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ''))
      .replace(/[#>*_`~-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return text
}

function messageText(message: ChatMessage): string {
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'thinking') return ''
      if (block.type === 'tool_use') {
        const result = block.result
        return `[工具 ${block.name}] ${result?.ok ? result.output : result?.error ?? ''}`.slice(0, 2000)
      }
      return block.type === 'error' ? block.message : ''
    })
    .filter(Boolean)
    .join('\n')
}

function makeSnippet(text: string, query: string): { snippet: string; highlights: SearchHighlight[] } {
  if (!query) return { snippet: '', highlights: [] }
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)
  if (index < 0) {
    return { snippet: text.slice(0, 120), highlights: [] }
  }
  const start = Math.max(0, index - 40)
  const end = Math.min(text.length, index + query.length + 80)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const before = text.slice(start, index)
  const matched = text.slice(index, index + query.length)
  const after = text.slice(index + query.length, end)
  const normalizedBefore = `${prefix}${before}`.replace(/\s+/g, ' ')
  const normalizedMatched = matched.replace(/\s+/g, ' ')
  return {
    snippet: `${normalizedBefore}${normalizedMatched}${after}${suffix}`.replace(/\s+/g, ' '),
    highlights: [{ start: normalizedBefore.length, end: normalizedBefore.length + normalizedMatched.length }]
  }
}

function matchScore(haystack: string, needle: string, base: number, bonus = 0): number {
  if (!needle) return 0
  const index = haystack.toLowerCase().indexOf(needle.toLowerCase())
  if (index < 0) return 0
  if (index === 0) return base + 40 + bonus
  return base + bonus
}

function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

export class WorkspaceSearchService {
  private readonly deps: WorkspaceSearchServiceDeps
  private readonly options: Required<WorkspaceSearchServiceOptions>
  private readonly now: () => number
  private readonly sessionIndex = new Map<string, SessionDoc>()
  /** workspace 绝对路径 → (absolutePath → FileDoc) */
  private readonly workspaceIndex = new Map<string, Map<string, FileDoc>>()
  private sessionSignatures = new Map<string, string>()
  private ready = false
  private building = false
  private started = false
  private lastBuildAt = 0
  private lastRefreshAt = 0
  private lastSessionRevision = 0
  private workspaceSet = new Set<string>()

  constructor(deps: WorkspaceSearchServiceDeps, options: WorkspaceSearchServiceOptions = {}) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.options = {
      maxFilesPerWorkspace: Math.max(100, options.maxFilesPerWorkspace ?? 5000),
      maxFileBytes: Math.max(4096, options.maxFileBytes ?? 512 * 1024),
      maxTextChars: Math.max(1000, options.maxTextChars ?? 20_000),
      autoRefreshMs: Math.max(0, options.autoRefreshMs ?? 1500)
    }
  }

  /** 启动时构建（可重复调用；已构建则只做增量刷新） */
  async start(): Promise<void> {
    if (this.building) return
    this.building = true
    try {
      this.rebuildSessions()
      this.workspaceSet = new Set(
        this.deps
          .listWorkspaces()
          .map((workspace) => normalizeWorkspaceOrNull(workspace))
          .filter((workspace): workspace is string => Boolean(workspace))
      )
      for (const workspace of this.workspaceSet) this.refreshWorkspaceSync(workspace, true)
      this.ready = true
      this.started = true
      this.lastBuildAt = this.now()
      this.lastRefreshAt = this.now()
      this.lastSessionRevision = this.deps.getSessionRevision?.() ?? 0
    } finally {
      this.building = false
    }
  }

  /** 手动全量重建（供 refresh channel/测试） */
  async rebuild(): Promise<SearchIndexStatus> {
    this.sessionIndex.clear()
    this.workspaceIndex.clear()
    this.sessionSignatures.clear()
    this.workspaceSet.clear()
    this.ready = false
    this.started = false
    await this.start()
    return this.status()
  }

  /** 保存会话后调用：只重索引一个会话（增量） */
  async refreshSession(sessionId: string): Promise<boolean> {
    const session = this.deps.getSession(sessionId)
    if (!session) {
      this.sessionIndex.delete(sessionId)
      this.sessionSignatures.delete(sessionId)
      return false
    }
    this.indexSession(session)
    this.ready = true
    return true
  }

  /** 工具/文件保存后调用：增量刷新一个工作区（按 mtime/size 跳过未变文件） */
  async refreshWorkspace(workspace: string | null | undefined): Promise<void> {
    const normalized = normalizeWorkspaceOrNull(workspace)
    if (!normalized) return
    this.workspaceSet.add(normalized)
    this.refreshWorkspaceSync(normalized, true)
    this.ready = true
    this.lastRefreshAt = this.now()
  }

  status(): SearchIndexStatus {
    let files = 0
    for (const map of this.workspaceIndex.values()) files += map.size
    let artifacts = 0
    for (const doc of this.sessionIndex.values()) artifacts += doc.artifacts.length
    return {
      ready: this.ready,
      building: this.building,
      sessions: this.sessionIndex.size,
      files,
      artifacts,
      workspaces: [...this.workspaceSet],
      ...(this.lastBuildAt > 0 ? { lastBuiltAt: this.lastBuildAt } : {})
    }
  }

  /** 查询（返回分组结果；空查询返回空） */
  async search(input: SearchQueryInput): Promise<SearchResponse> {
    const startedAt = this.now()
    await this.ensureStarted()
    await this.refreshIfStale()
    const q = typeof input.q === 'string' ? input.q.trim() : ''
    const limit = Math.max(1, Math.min(60, Math.trunc(input.limit ?? 20)))
    const workspace = normalizeWorkspaceOrNull(input.workspace)
    // 首次查询某个工作区时立即索引，避免它因为自动刷新节流而返回空文件结果。
    if (workspace && !this.workspaceIndex.has(workspace)) {
      this.workspaceSet.add(workspace)
      this.refreshWorkspaceSync(workspace, true)
      this.lastRefreshAt = this.now()
    }
    // 全局搜索：首次查询时补齐启动后才出现的工作区，避免刚新建会话搜不到文件
    if (!workspace) {
      for (const raw of this.deps.listWorkspaces()) {
        const known = normalizeWorkspaceOrNull(raw)
        if (!known || this.workspaceIndex.has(known)) continue
        this.workspaceSet.add(known)
        this.refreshWorkspaceSync(known, true)
      }
    }
    const groups: SearchGroups = { sessions: [], files: [], artifacts: [] }
    if (!q) {
      return { query: q, groups, total: 0, tookMs: this.now() - startedAt, index: this.status() }
    }
    const perGroup = Math.max(1, Math.ceil(limit / 3))
    groups.sessions = this.searchSessions(q, perGroup, workspace)
    groups.files = workspace ? this.searchFiles(q, workspace, perGroup) : this.searchFilesAll(q, perGroup)
    groups.artifacts = this.searchArtifacts(q, workspace, perGroup)
    for (const group of [groups.sessions, groups.files, groups.artifacts]) {
      group.sort((a, b) => b.score - a.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    }
    const total = groups.sessions.length + groups.files.length + groups.artifacts.length
    return {
      query: q,
      groups,
      total,
      tookMs: Math.max(0, this.now() - startedAt),
      index: this.status()
    }
  }

  private async ensureStarted(): Promise<void> {
    if (!this.started) await this.start()
  }

  private async refreshIfStale(): Promise<void> {
    const revision = this.deps.getSessionRevision?.()
    const revisionChanged = revision !== undefined && revision !== this.lastSessionRevision
    if (!revisionChanged && this.now() - this.lastRefreshAt < this.options.autoRefreshMs) return
    this.lastRefreshAt = this.now()
    if (revision !== undefined) this.lastSessionRevision = revision
    try {
      // 会话：按 updatedAt/messageCount 签名增量更新，新增/删除也同步
      const metas = this.deps.listSessions()
      const seen = new Set<string>()
      for (const meta of metas) {
        seen.add(meta.id)
        const signature = `${meta.updatedAt}:${meta.messageCount}:${meta.title}`
        if (this.sessionSignatures.get(meta.id) === signature) continue
        const session = this.deps.getSession(meta.id)
        if (session) this.indexSession(session)
        else this.sessionSignatures.set(meta.id, signature)
      }
      for (const id of [...this.sessionIndex.keys()]) {
        if (!seen.has(id)) {
          this.sessionIndex.delete(id)
          this.sessionSignatures.delete(id)
        }
      }
      // 工作区：同步已知集合，删掉不再被最近工作区/会话引用的文件索引
      const knownWorkspaces = new Set(
        this.deps
          .listWorkspaces()
          .map((workspace) => normalizeWorkspaceOrNull(workspace))
          .filter((workspace): workspace is string => Boolean(workspace))
      )
      for (const workspace of [...this.workspaceSet]) {
        if (knownWorkspaces.has(workspace)) continue
        this.workspaceSet.delete(workspace)
        this.workspaceIndex.delete(workspace)
      }
      for (const workspace of knownWorkspaces) this.workspaceSet.add(workspace)
      // 只刷新已索引过的目录（增量 stat）
      for (const workspace of this.workspaceSet) this.refreshWorkspaceSync(workspace, false)
    } catch {
      // 索引刷新失败不阻断查询（保留旧索引）
    }
  }

  private rebuildSessions(): void {
    this.sessionIndex.clear()
    this.sessionSignatures.clear()
    for (const meta of this.deps.listSessions()) {
      const session = this.deps.getSession(meta.id)
      if (session) this.indexSession(session)
    }
  }

  private indexSession(session: Session): void {
    const visibleMessages = session.messages.filter((message) => !message.hidden)
    const messages: SessionDoc['messages'] = []
    let messageBudget = SEARCH_SESSION_TEXT_BUDGET
    for (let index = visibleMessages.length - 1; index >= 0 && messageBudget > 0; index -= 1) {
      const message = visibleMessages[index]
      const text = messageText(message).slice(0, Math.min(this.options.maxTextChars, messageBudget))
      if (!text.trim()) continue
      messages.unshift({ id: message.id, role: message.role, text })
      messageBudget -= text.length
    }
    const artifacts: SessionDoc['artifacts'] = []
    let artifactBudget = SEARCH_SESSION_ARTIFACT_BUDGET
    for (let index = session.artifacts.length - 1; index >= 0 && artifactBudget > 0; index -= 1) {
      const artifact = session.artifacts[index]
      const content = artifact.content
        ? stripMarkup(artifact.content, artifact.kind).slice(0, Math.min(this.options.maxTextChars, artifactBudget))
        : undefined
      artifacts.unshift({
        artifact: content ? { ...artifact, content } : { ...artifact, content: undefined },
        sessionTitle: session.title
      })
      artifactBudget -= content?.length ?? 0
    }
    const doc: SessionDoc = {
      id: session.id,
      title: session.title,
      workspace: normalizeWorkspaceOrNull(session.workspace),
      updatedAt: session.updatedAt,
      messages,
      artifacts
    }
    this.sessionIndex.set(session.id, doc)
    this.sessionSignatures.set(session.id, `${session.updatedAt}:${session.messages.length}:${session.title}`)
    if (doc.workspace) this.workspaceSet.add(doc.workspace)
  }

  private refreshWorkspaceSync(workspace: string, force: boolean): void {
    const normalized = normalizeWorkspaceOrNull(workspace)
    if (!normalized) return
    const existing = this.workspaceIndex.get(normalized) ?? new Map<string, FileDoc>()
    const next = new Map<string, FileDoc>()
    let scanned = 0
    const maxFiles = this.options.maxFilesPerWorkspace

    const walk = (dir: string, depth: number): void => {
      if (depth > 8 || scanned >= maxFiles) return
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      for (const entry of entries) {
        if (scanned >= maxFiles) return
        if (entry.isSymbolicLink()) continue
        const absolute = join(dir, entry.name)
        if (this.shouldIgnorePath(absolute, entry.name)) continue
        if (entry.isDirectory()) {
          walk(absolute, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        scanned += 1
        const cached = existing.get(absolute)
        try {
          const stat = statSync(absolute)
          if (!force && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            next.set(absolute, cached)
            continue
          }
          if (stat.size > this.options.maxFileBytes) {
            next.set(absolute, {
              absolutePath: absolute,
              relPath: relative(normalized, absolute).split('\\').join('/'),
              name: entry.name,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              text: null,
              binary: true
            })
            continue
          }
          const buffer = readFileSync(absolute)
          const binary = buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)
          next.set(absolute, {
            absolutePath: absolute,
            relPath: relative(normalized, absolute).split('\\').join('/'),
            name: entry.name,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            text: binary ? null : buffer.toString('utf8').slice(0, this.options.maxTextChars),
            binary
          })
        } catch {
          // 单文件读取失败跳过
        }
      }
    }
    walk(normalized, 0)
    // walk 从头构建 next（已删除/被忽略的文件自然不在 next 中）
    this.workspaceIndex.set(normalized, next)
  }

  private shouldIgnorePath(absolute: string, name: string): boolean {
    if (IGNORED_DIR_NAMES.has(name)) return true
    const normalized = absolute.split('\\').join('/').toLowerCase()
    if (this.deps.dataDir) {
      const dataDir = this.deps.dataDir.split('\\').join('/').toLowerCase().replace(/\/+$/, '')
      if (normalized === dataDir || normalized.startsWith(`${dataDir}/`)) return true
    }
    return false
  }

  private searchSessions(query: string, limit: number, workspace: string | null = null): SearchHit[] {
    const hits: SearchHit[] = []
    for (const doc of this.sessionIndex.values()) {
      // 工作区隔离：限定工作区时不返回其它工作区/未绑定工作区的会话
      if (workspace && doc.workspace !== workspace) continue
      const titleScore = matchScore(doc.title, query, 120)
      let bestMessage: SessionDoc['messages'][number] | null = null
      let bestMessageScore = 0
      for (const message of doc.messages) {
        const score = matchScore(message.text, query, 40)
        if (score > bestMessageScore) {
          bestMessageScore = score
          bestMessage = message
        }
      }
      const score = Math.max(titleScore, bestMessageScore)
      if (score <= 0) continue
      const source = titleScore >= bestMessageScore ? doc.title : bestMessage?.text ?? ''
      const snippet = makeSnippet(source, query)
      // 近期会话优先：0-8 天的衰减加分（旧实现按绝对天数取模，顺序与新旧无关）
      const ageDays = Math.max(0, (this.now() - (doc.updatedAt ?? 0)) / 86_400_000)
      const recencyBonus = Math.max(0, 8 - Math.floor(ageDays))
      hits.push({
        kind: 'session',
        id: doc.id,
        title: doc.title,
        snippet: snippet.snippet,
        highlights: snippet.highlights,
        score: score + recencyBonus,
        sessionId: doc.id,
        ...(titleScore < bestMessageScore && bestMessage ? { messageId: bestMessage.id, role: bestMessage.role } : {}),
        updatedAt: doc.updatedAt
      })
      if (hits.length >= limit * 2) break
    }
    return hits.slice(0, limit)
  }

  private searchFilesAll(query: string, limit: number): SearchHit[] {
    const hits: SearchHit[] = []
    for (const workspace of this.workspaceIndex.keys()) {
      hits.push(...this.searchFiles(query, workspace, limit))
    }
    hits.sort((a, b) => b.score - a.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return hits.slice(0, limit)
  }

  private searchFiles(query: string, workspace: string, limit: number): SearchHit[] {
    const index = this.workspaceIndex.get(workspace)
    if (!index) return []
    const hits: SearchHit[] = []
    for (const doc of index.values()) {
      const nameScore = matchScore(doc.name, query, 70)
      const pathScore = matchScore(doc.relPath, query, 45)
      const contentScore = doc.text ? matchScore(doc.text, query, 25) : 0
      const score = Math.max(nameScore, pathScore, contentScore)
      if (score <= 0) continue
      let snippet = makeSnippet(doc.text ? '' : doc.relPath, query)
      let line: number | undefined
      if (contentScore > 0 && doc.text) {
        snippet = makeSnippet(doc.text, query)
        const indexInText = doc.text.toLowerCase().indexOf(query.toLowerCase())
        if (indexInText >= 0) line = lineNumberAt(doc.text, indexInText)
      } else {
        snippet = makeSnippet(doc.relPath, query)
      }
      hits.push({
        kind: 'file',
        id: doc.absolutePath,
        title: doc.name,
        snippet: snippet.snippet,
        highlights: snippet.highlights,
        score,
        path: doc.relPath,
        absolutePath: doc.absolutePath,
        ...(line ? { line } : {}),
        updatedAt: doc.mtimeMs
      })
      if (hits.length >= limit * 3) break
    }
    return hits.slice(0, limit)
  }

  private searchArtifacts(query: string, workspace: string | null, limit: number): SearchHit[] {
    const hits: SearchHit[] = []
    for (const doc of this.sessionIndex.values()) {
      if (workspace && doc.workspace !== workspace) continue
      for (const { artifact, sessionTitle } of doc.artifacts) {
        const titleScore = matchScore(artifact.title, query, 80)
        const contentScore = artifact.content ? matchScore(artifact.content, query, 25) : 0
        const score = Math.max(titleScore, contentScore)
        if (score <= 0) continue
        const snippet = makeSnippet(titleScore >= contentScore ? artifact.title : artifact.content ?? '', query)
        hits.push({
          kind: 'artifact',
          id: artifact.id,
          title: artifact.title || `未命名产物（${sessionTitle}）`,
          snippet: snippet.snippet,
          highlights: snippet.highlights,
          score,
          sessionId: doc.id,
          artifactId: artifact.id,
          artifactKind: artifact.kind,
          ...(artifact.path ? { path: artifact.path } : {}),
          updatedAt: artifact.updatedAt
        })
        if (hits.length >= limit * 3) break
      }
      if (hits.length >= limit * 3) break
    }
    return hits.slice(0, limit)
  }
}

export { normalizeWorkspace as normalizeSearchWorkspace }
