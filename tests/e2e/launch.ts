/**
 * Playwright Electron 启动器 —— 所有 E2E 用例统一从这里启动 Morrow。
 *
 * 本机环境要点（与 scripts/shot.mjs 一致，别绕过）：
 * 1. DSH 会话的子进程带受限令牌：Electron 必须加 `--no-sandbox` 才不崩；
 * 2. Chromium 的 `--user-data-dir` 与 Morrow 的 `--data-dir` 必须落在项目 `tmp/` 内
 *    （子进程只能写工作区）；每个测试用独立目录，避免单实例锁/缓存互相污染；
 * 3. 必须删除 `ELECTRON_RUN_AS_NODE`（DSH 运行时会设置，否则 electron.exe 退化成 node）。
 *
 * 启动的是构建产物：`out/main/index.js`（先 `npm run build`）。
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// 项目没有 "type": "module"，Playwright 会按 CJS 转译 .ts，因此这里用 __dirname。
// launch.ts 位于 tests/e2e/ → 根目录是 ../..
const here = __dirname
/** 项目根目录（tests/e2e/launch.ts → ../..） */
export const root = resolve(here, '..', '..')
/** 截图与证据目录：docs/verification/screens */
export const screensDir = join(root, 'docs', 'verification', 'screens')

export interface ElectronEnvExtra {
  [key: string]: string | undefined
}

/**
 * 清理 Electron 启动环境：删除 ELECTRON_RUN_AS_NODE，过滤 undefined。
 * （与 scripts/env.mjs 的 electronEnv 等价；E2E 侧独立一份，避免跨目录导入的类型噪音。）
 */
export function electronEnv(extra: ElectronEnvExtra = {}): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...process.env, ...extra }
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string' && key !== 'ELECTRON_RUN_AS_NODE') cleaned[key] = value
  }
  return cleaned
}

export interface LaunchOptions {
  /** 用于区分 tmp 目录与截图名字，默认 'e2e' */
  name?: string
  /** 追加启动参数 */
  extraArgs?: string[]
  /** 追加环境变量（MORROW_TEST 自动为 '1'） */
  env?: ElectronEnvExtra
  /** 指定可执行文件（打包冒烟时指向 win-unpacked/Morrow.exe） */
  executablePath?: string
  /** 是否等待窗口 ready-to-show（默认等 domcontentloaded） */
  waitForSelector?: string
  /** 启动超时，默认 60s */
  timeoutMs?: number
  /** 复用已有 Morrow 数据目录（会话恢复测试用） */
  dataDir?: string
  /** 复用已有 Chromium user-data-dir */
  chromiumDir?: string
}

export interface MorrowApp {
  app: ElectronApplication
  page: Page
  /** Morrow 数据目录（--data-dir） */
  dataDir: string
  /** Chromium user-data-dir */
  chromiumDir: string
  close(): Promise<void>
}

/** 等第一个窗口并加载完成。灵动岛模式下主窗口与岛窗口创建顺序有竞争，优先返回主窗口。 */
async function waitFirstWindow(app: ElectronApplication, opts: LaunchOptions): Promise<Page> {
  const timeout = opts.timeoutMs ?? 60_000
  const started = Date.now()
  let page = await app.firstWindow({ timeout })
  if (page.url().includes('#island')) {
    while (Date.now() - started < timeout) {
      const main = app.windows().find((candidate) => !candidate.isClosed() && !candidate.url().includes('#island'))
      if (main) {
        page = main
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  await page.waitForLoadState('domcontentloaded')
  if (opts.waitForSelector) await page.waitForSelector(opts.waitForSelector, { timeout })
  return page
}

/** 等窗口真正显示（main 进程里是 ready-to-show 后才 show()，与 DOM 加载有先后竞争）。 */
export async function waitForWindowVisible(app: ElectronApplication, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const visible = await app.evaluate(async ({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().some((win) => win.isVisible())
    })
    if (visible) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`窗口在 ${timeoutMs}ms 内没有显示（ready-to-show 未触发？）`)
}

/** 读取所有窗口的可见性/标题/尺寸，供测试断言。 */
export async function windowStates(app: ElectronApplication): Promise<
  Array<{ visible: boolean; title: string; bounds: { width: number; height: number } }>
> {
  return app.evaluate(async ({ BrowserWindow }) => {
    return BrowserWindow.getAllWindows().map((win) => ({
      visible: win.isVisible(),
      title: win.getTitle(),
      bounds: win.getBounds()
    }))
  })
}

/**
 * 启动 Morrow 的 Electron（构建产物版）。
 * @example
 *   const morrow = await launchMorrow({ name: 'smoke' })
 *   try { await morrow.page.screenshot({ path: 'x.png' }) } finally { await morrow.close() }
 */
export async function launchMorrow(opts: LaunchOptions = {}): Promise<MorrowApp> {
  const id = `${opts.name ?? 'e2e'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tmpDir = join(root, 'tmp')
  const chromiumDir = opts.chromiumDir ?? join(tmpDir, `chromium-${id}`)
  const dataDir = opts.dataDir ?? join(tmpDir, `data-${id}`)
  const executablePath = opts.executablePath ?? process.env.MORROW_E2E_EXE
  mkdirSync(chromiumDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  // 原生媒体工具会写临时脚本；与当前 Electron 实例一起隔离，避免依赖
  // 系统 TEMP 的写入权限，也不改变测试运行器创建 Git 夹具的临时目录。
  const runtimeTemp = join(chromiumDir, 'runtime-temp')
  mkdirSync(runtimeTemp, { recursive: true })

  // 缺少构建产物时 Electron 会弹「Unable to find Electron app」模态框并挂起整轮 E2E；
  // 在启动前先失败，把原因直接写进测试报告。
  if (!executablePath) {
    const mainEntry = join(root, 'out', 'main', 'index.js')
    if (!existsSync(mainEntry)) {
      throw new Error('缺少构建产物 out/main/index.js：请先运行 npm run build，且 E2E 运行期间不要重新构建 out。')
    }
  }

  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      '.',
      '--no-sandbox',
      `--user-data-dir=${chromiumDir}`,
      `--data-dir=${dataDir}`,
      '--test-mode',
      ...(opts.extraArgs ?? [])
    ],
    cwd: root,
    env: electronEnv({ MORROW_TEST: '1', TEMP: runtimeTemp, TMP: runtimeTemp, ...(opts.env ?? {}) }),
    timeout: opts.timeoutMs ?? 60_000
  })

  try {
    const page = await waitFirstWindow(app, opts)
    // 等窗口真正 show()，避免测试在 ready-to-show 之前断言 isVisible
    await waitForWindowVisible(app, opts.timeoutMs ?? 15_000)
    return {
      app,
      page,
      dataDir,
      chromiumDir,
      async close() {
        try {
          await app.close()
        } catch {
          // 进程可能已被测试主动关闭
        }
      }
    }
  } catch (err) {
    await app.close().catch(() => {})
    throw err
  }
}

/** 确保截图目录存在，返回文件路径。先删除旧文件，避免 Windows 上覆盖被缩略图/索引服务短暂占用。 */
export function screenshotPath(name: string): string {
  mkdirSync(screensDir, { recursive: true })
  const target = join(screensDir, name)
  try {
    rmSync(target, { force: true })
  } catch {
    // 删除失败时仍交给 Playwright 覆盖
  }
  return target
}
