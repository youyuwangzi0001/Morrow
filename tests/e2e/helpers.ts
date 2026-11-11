// Electron 端到端共用辅助：由 launch、store 扁平合并。
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// 项目没有 "type": "module"，Playwright 会按 CJS 转译 .ts，因此这里用 __dirname。
// launch.ts 位于 tests/e2e/ → 根目录是 ../..
const here = __dirname
/** 项目根目录（tests/e2e/helpers.ts → ../..） */
export const root = resolve(here, '..', '..')
/** 测试截图目录：只写 tmp，不进入文档体系。 */
export const screensDir = join(root, 'tmp', 'e2e-screens')

export interface ElectronEnvExtra {
  [key: string]: string | undefined
}

/**
 * 清理 Electron 启动环境：删除 ELECTRON_RUN_AS_NODE，过滤 undefined。
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

/** 等主窗口稳定在默认物理尺寸（2100×1200）；文档截图要求精确像素尺寸。 */
export async function waitForDefaultWindowSize(app: ElectronApplication, timeoutMs = 6_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const size = await app.evaluate(async ({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('#island'))
      if (!win) return null
      const content = win.getContentBounds()
      const scale = screen.getPrimaryDisplay().scaleFactor || 1
      return { width: Math.round(content.width * scale), height: Math.round(content.height * scale) }
    })
    if (size?.width === 2100 && size?.height === 1200) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
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

export interface E2EStreamEvent {
  type: string
  runId?: string
  sessionId?: string
  seq?: number
  [key: string]: unknown
}

export interface StoreSessionSnapshot {
  id: string
  title: string
  workspace: string | null
  messages: Array<{ id: string; role: string; blocks: string[]; interrupted: boolean; text: string }>
  artifacts: Array<{ id: string; title: string; kind: string; path?: string }>
  todos: Array<{ id: string; text: string; status: string }>
  superAgent?: {
    status: string
    projectId: string
    planRevision: number
    tasks: Array<{
      id: string
      title: string
      taskId: string
      status: string
      attempts: number
      planRemoved: boolean
      conflictCount: number
      startedAt: number
      finishedAt: number
      waitingForApproval: boolean
      summary: string
      error: string
      note: string
      waitReason: string
      workspaceCopy: {
        copyId: string
        mode: string
        baseVersion: string
        path: string
        fileCount: number
      } | null
      needsRetest: boolean
      staleArtifacts: string[]
      earlyStartedBy: string[]
      artifactUsage: Array<{
        name: string
        version: number
        attemptId: string
        readAt: number
        status: string
      }>
      verify: { files: string[]; command: string } | null
      verification: {
        candidateVersion: string
        status: string
        checkedAt: number
        attempt: number
        reworkCount: number
        maxReworks: number
        command: { command: string; exitCode: number | null; output: string; timedOut: boolean } | null
        files: Array<{ path: string; required: boolean; exists: boolean; hash: string }>
        error: string
      } | null
      verificationHistory: Array<{
        candidateVersion: string
        status: string
        attempt: number
        reworkCount: number
        maxReworks: number
        command: { command: string; exitCode: number | null; output: string; timedOut: boolean } | null
        files: Array<{ path: string; required: boolean; exists: boolean; hash: string }>
        error: string
      }>
      reworkFeedback: string
      reworkCount: number
      usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null
    }>
    usage: {
      inputTokens: number
      outputTokens: number
      totalTokens: number
      acceptedTasks: number
      failedAttempts: number
    } | null
    conflicts: Array<{
      id: string
      taskId: string
      path: string
      reason: string
      currentPreview: string
      incomingPreview: string
    }>
    artifacts: Array<{
      id: string
      name: string
      version: number
      status: string
      path: string
      taskId: string
      summary: string
      hash: string
      publishedAt: number
    }>
  } | null
}

export interface StoreSnapshot {
  ready: boolean
  bootError: string | null
  activeSessionId: string | null
  run: { runId: string; sessionId: string } | null
  runs: Array<{ runId: string; sessionId: string }>
  pendingPermission: {
    id: string
    toolName: string
    title: string
    risk: string
    summary: string
    allowAlways?: boolean
  } | null
  pendingQuestion: { id: string; question: string } | null
  session: StoreSessionSnapshot | null
  sessions: Array<{ id: string; title: string }>
  canvas: { open: boolean; artifactId: string | null }
  theme: string
  demoStep: { index: number; total: number; caption: string } | null
  toast: { kind: string; message: string } | null
  paletteOpen: boolean
  settingsOpen: boolean
  sidebarCollapsed: boolean
  hasAnyApiKey: boolean
  canOpenArtifact: boolean
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 通用轮询：check() 返回真值即返回；超时抛错并带上最后错误。 */
export async function waitUntil<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  label: string,
  intervalMs = 150
): Promise<T> {
  const started = Date.now()
  let lastError: unknown = null
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check()
      if (value) return value as T
    } catch (err) {
      lastError = err
    }
    await sleep(intervalMs)
  }
  const suffix = lastError ? `；最后错误：${lastError instanceof Error ? lastError.message : String(lastError)}` : ''
  throw new Error(`等待超时（${timeoutMs}ms）：${label}${suffix}`)
}

/** 读取 store 的稳定快照（只序列化可结构化克隆的字段）。 */
export async function readStore(page: Page): Promise<StoreSnapshot> {
  return page.evaluate(() => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const s = store.getState()
    const session = s.session
    const textOf = (message: Record<string, any>): string =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((block: Record<string, any>) => block.type === 'text')
        .map((block: Record<string, any>) => String(block.text ?? ''))
        .join('')
        .slice(0, 240)
    return {
      ready: Boolean(s.ready),
      bootError: s.bootError ?? null,
      activeSessionId: s.activeSessionId ?? null,
      run: s.run ? { runId: s.run.runId, sessionId: s.run.sessionId } : null,
      runs: Object.values(s.runs ?? {}).map((run: any) => ({ runId: String(run.runId), sessionId: String(run.sessionId) })),
      pendingPermission: s.pendingPermission
        ? {
            id: s.pendingPermission.id,
            toolName: s.pendingPermission.toolName,
            title: s.pendingPermission.title,
            risk: s.pendingPermission.risk,
            summary: s.pendingPermission.summary,
            allowAlways: s.pendingPermission.allowAlways
          }
        : null,
      pendingQuestion: s.pendingQuestion ? { id: s.pendingQuestion.id, question: s.pendingQuestion.question } : null,
      session: session
        ? {
            id: session.id,
            title: session.title,
            workspace: session.workspace ?? null,
            messages: (session.messages ?? []).map((message: Record<string, any>) => ({
              id: message.id,
              role: message.role,
              blocks: (message.content ?? []).map((block: Record<string, any>) => block.type),
              interrupted: Boolean(message.interrupted),
              text: textOf(message)
            })),
            artifacts: (session.artifacts ?? []).map((artifact: Record<string, any>) => ({
              id: artifact.id,
              title: artifact.title,
              kind: artifact.kind,
              path: artifact.path
            })),
            todos: (session.todos ?? []).map((todo: Record<string, any>) => ({
              id: todo.id,
              text: todo.text,
              status: todo.status
            })),
            superAgent: session.superAgent
              ? {
                  status: String(session.superAgent.status),
                  projectId: String(session.superAgent.projectId ?? ''),
                  planRevision: Number(session.superAgent.planRevision) || 1,
                  tasks: (session.superAgent.tasks ?? []).map((task: Record<string, any>) => ({
                    id: String(task.id),
                    title: String(task.title),
                    taskId: String(task.taskId ?? task.id),
                    status: String(task.status),
                    attempts: Number(task.attempts) || 0,
                    planRemoved: task.planRemoved === true,
                    conflictCount: Number(task.conflictCount) || 0,
                    startedAt: Number(task.startedAt) || 0,
                    finishedAt: Number(task.finishedAt) || 0,
                    waitingForApproval: task.waitingForApproval === true,
                    summary: String(task.summary ?? ''),
                    error: String(task.error ?? ''),
                    note: String(task.note ?? ''),
                    waitReason: String(task.waitReason ?? ''),
                    workspaceCopy: task.workspaceCopy
                      ? {
                          copyId: String(task.workspaceCopy.copyId),
                          mode: String(task.workspaceCopy.mode),
                          baseVersion: String(task.workspaceCopy.baseVersion),
                          path: String(task.workspaceCopy.path),
                          fileCount: Number(task.workspaceCopy.fileCount) || 0
                        }
                      : null,
                    needsRetest: task.needsRetest === true,
                    staleArtifacts: Array.isArray(task.staleArtifacts)
                      ? task.staleArtifacts.map((item: unknown) => String(item))
                      : [],
                    earlyStartedBy: Array.isArray(task.earlyStartedBy)
                      ? task.earlyStartedBy.map((item: unknown) => String(item))
                      : [],
                    artifactUsage: Array.isArray(task.artifactUsage)
                      ? task.artifactUsage.map((usage: Record<string, any>) => ({
                          name: String(usage.name),
                          version: Number(usage.version) || 0,
                          attemptId: String(usage.attemptId ?? ''),
                          readAt: Number(usage.readAt) || 0,
                          status: String(usage.status ?? 'current')
                        }))
                      : [],
                    verify: task.verify
                      ? {
                          files: Array.isArray(task.verify.files)
                            ? task.verify.files.map((file: unknown) => String(file))
                            : [],
                          command: String(task.verify.command ?? '')
                        }
                      : null,
                    verification: task.verification
                      ? {
                          candidateVersion: String(task.verification.candidateVersion ?? ''),
                          status: String(task.verification.status ?? 'pending'),
                          checkedAt: Number(task.verification.checkedAt) || 0,
                          attempt: Number(task.verification.attempt) || 0,
                          reworkCount: Number(task.verification.reworkCount) || 0,
                          maxReworks: Number(task.verification.maxReworks) || 0,
                          command: task.verification.command
                            ? {
                                command: String(task.verification.command.command ?? ''),
                                exitCode:
                                  typeof task.verification.command.exitCode === 'number'
                                    ? task.verification.command.exitCode
                                    : null,
                                output: String(task.verification.command.output ?? ''),
                                timedOut: task.verification.command.timedOut === true
                              }
                            : null,
                          files: Array.isArray(task.verification.files)
                            ? task.verification.files.map((file: Record<string, any>) => ({
                                path: String(file.path ?? ''),
                                required: file.required === true,
                                exists: file.exists === true,
                                hash: String(file.hash ?? '')
                              }))
                            : [],
                          error: String(task.verification.error ?? '')
                        }
                      : null,
                    verificationHistory: Array.isArray(task.verificationHistory)
                      ? task.verificationHistory.map((record: Record<string, any>) => ({
                          candidateVersion: String(record.candidateVersion ?? ''),
                          status: String(record.status ?? 'pending'),
                          attempt: Number(record.attempt) || 0,
                          reworkCount: Number(record.reworkCount) || 0,
                          maxReworks: Number(record.maxReworks) || 0,
                          command: record.command
                            ? {
                                command: String(record.command.command ?? ''),
                                exitCode:
                                  typeof record.command.exitCode === 'number' ? record.command.exitCode : null,
                                output: String(record.command.output ?? ''),
                                timedOut: record.command.timedOut === true
                              }
                            : null,
                          files: Array.isArray(record.files)
                            ? record.files.map((file: Record<string, any>) => ({
                                path: String(file.path ?? ''),
                                required: file.required === true,
                                exists: file.exists === true,
                                hash: String(file.hash ?? '')
                              }))
                            : [],
                          error: String(record.error ?? '')
                        }))
                      : [],
                    reworkFeedback: String(task.reworkFeedback ?? ''),
                    reworkCount: Number(task.reworkCount) || 0,
                    usage: task.usage
                      ? {
                          inputTokens: Number(task.usage.inputTokens) || 0,
                          outputTokens: Number(task.usage.outputTokens) || 0,
                          totalTokens: Number(task.usage.totalTokens) || 0
                        }
                      : null,
                    stuck: task.stuck
                      ? {
                          id: String(task.stuck.id),
                          taskId: String(task.stuck.taskId ?? ''),
                          taskTitle: String(task.stuck.taskTitle ?? ''),
                          reason: String(task.stuck.reason ?? ''),
                          status: String(task.stuck.status ?? 'open'),
                          resolution: String(task.stuck.resolution ?? ''),
                          detectedAt: Number(task.stuck.detectedAt) || 0,
                          lastEffectiveAt: Number(task.stuck.lastEffectiveAt) || 0,
                          stepsSinceProgress: Number(task.stuck.stepsSinceProgress) || 0,
                          repeatedCount: Number(task.stuck.repeatedCount) || 0,
                          lastOperation: String(task.stuck.lastOperation ?? ''),
                          evidence: Array.isArray(task.stuck.evidence)
                            ? task.stuck.evidence.map((operation: Record<string, any>) => ({
                                id: String(operation.id ?? ''),
                                name: String(operation.name ?? ''),
                                title: String(operation.title ?? ''),
                                status: String(operation.status ?? ''),
                                input: String(operation.input ?? ''),
                                target: String(operation.target ?? ''),
                                error: String(operation.error ?? ''),
                                effective: operation.effective === true
                              }))
                            : []
                        }
                      : null
                  })),
                  usage: session.superAgent.usage
                    ? {
                        inputTokens: Number(session.superAgent.usage.inputTokens) || 0,
                        outputTokens: Number(session.superAgent.usage.outputTokens) || 0,
                        totalTokens: Number(session.superAgent.usage.totalTokens) || 0,
                        acceptedTasks: Number(session.superAgent.usage.acceptedTasks) || 0,
                        failedAttempts: Number(session.superAgent.usage.failedAttempts) || 0
                      }
                    : null,
                  conflicts: (session.superAgent.conflicts ?? [])
                    .filter((conflict: Record<string, any>) => conflict.status === 'open')
                    .map((conflict: Record<string, any>) => ({
                      id: String(conflict.id),
                      taskId: String(conflict.taskId ?? ''),
                      path: String(conflict.path),
                      reason: String(conflict.reason),
                      currentPreview: String(conflict.currentPreview ?? ''),
                      incomingPreview: String(conflict.incomingPreview ?? '')
                    })),
                  artifacts: (session.superAgent.artifacts ?? []).map((artifact: Record<string, any>) => ({
                    id: String(artifact.id),
                    name: String(artifact.name),
                    version: Number(artifact.version) || 0,
                    status: String(artifact.status),
                    path: String(artifact.path ?? ''),
                    taskId: String(artifact.taskId ?? ''),
                    summary: String(artifact.summary ?? ''),
                    hash: String(artifact.hash ?? ''),
                    publishedAt: Number(artifact.publishedAt) || 0
                  })),
                  stuckAlerts: (session.superAgent.stuckAlerts ?? []).map((alert: Record<string, any>) => ({
                    id: String(alert.id),
                    taskId: String(alert.taskId ?? ''),
                    taskTitle: String(alert.taskTitle ?? ''),
                    reason: String(alert.reason ?? ''),
                    status: String(alert.status ?? 'open'),
                    resolution: String(alert.resolution ?? ''),
                    detectedAt: Number(alert.detectedAt) || 0,
                    lastEffectiveAt: Number(alert.lastEffectiveAt) || 0,
                    stepsSinceProgress: Number(alert.stepsSinceProgress) || 0,
                    repeatedCount: Number(alert.repeatedCount) || 0
                  }))
                }
              : null
          }
        : null,
      sessions: (s.sessions ?? []).map((meta: Record<string, any>) => ({
        id: meta.id,
        title: meta.title,
        pinned: Boolean(meta.pinned),
        archived: Boolean(meta.archived)
      })),
      canvas: { open: Boolean(s.canvas?.open), artifactId: s.canvas?.artifactId ?? null },
      theme: s.theme,
      demoStep: s.demoStep ? { index: s.demoStep.index, total: s.demoStep.total, caption: s.demoStep.caption } : null,
      toast: s.toast ? { kind: s.toast.kind, message: s.toast.message } : null,
      paletteOpen: Boolean(s.paletteOpen),
      settingsOpen: Boolean(s.settingsOpen),
      sidebarCollapsed: Boolean(s.sidebarCollapsed),
      hasAnyApiKey: Boolean(s.hasAnyApiKey),
      canOpenArtifact: Boolean(s.canvas)
    }
  })
}

/** 等 store 初始化完成（bootstrap 完成、应用壳可交互）。 */
export async function waitForStoreReady(page: Page, timeoutMs = 30_000): Promise<StoreSnapshot> {
  return waitUntil(async () => {
    const state = await readStore(page)
    return state.ready ? state : null
  }, timeoutMs, 'store ready')
}

/** 开始收集主进程推来的 RuntimeEvent（同一次运行内可重复安装，会替换旧收集器）。 */
export async function installEventCollector(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as {
      __e2eEvents?: E2EStreamEvent[]
      __e2eOff?: () => void
    }
    if (typeof scope.__e2eOff === 'function') {
      try {
        scope.__e2eOff()
      } catch {
        // 忽略
      }
    }
    scope.__e2eEvents = []
    scope.__e2eOff = window.morrow.onEvent((event) => {
      scope.__e2eEvents!.push(event as unknown as E2EStreamEvent)
    })
  })
}

export async function clearEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as { __e2eEvents?: E2EStreamEvent[] }).__e2eEvents = []
  })
}

export async function getEvents(page: Page): Promise<E2EStreamEvent[]> {
  return page.evaluate(() => {
    return ((window as unknown as { __e2eEvents?: E2EStreamEvent[] }).__e2eEvents ?? []) as E2EStreamEvent[]
  })
}

/** 等某个类型的 RuntimeEvent（可用 Node 侧谓词进一步过滤）。 */
export async function waitForEvent(
  page: Page,
  type: string,
  predicate: (event: E2EStreamEvent) => boolean = () => true,
  timeoutMs = 60_000
): Promise<E2EStreamEvent> {
  return waitUntil(
    async () => (await getEvents(page)).find((event) => event.type === type && predicate(event)) ?? null,
    timeoutMs,
    `事件 ${type}`
  )
}

/** 等当前 run 结束，返回 run_finished 事件。 */
export async function waitForRunFinished(page: Page, timeoutMs = 180_000): Promise<E2EStreamEvent> {
  return waitUntil(
    async () => (await getEvents(page)).findLast((event) => event.type === 'run_finished') ?? null,
    timeoutMs,
    'run_finished'
  )
}

/** 等出现待审批请求（状态 + 事件双确认）。 */
export async function waitForPermission(page: Page, timeoutMs = 120_000): Promise<NonNullable<StoreSnapshot['pendingPermission']>> {
  return waitUntil(async () => (await readStore(page)).pendingPermission, timeoutMs, 'pendingPermission')
}

export async function sendMessageViaStore(page: Page, text: string): Promise<void> {
  await page.evaluate((message: string) => {
    return (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      .getState()
      .sendMessage(message)
  }, text)
}

export async function stopRunViaStore(page: Page): Promise<void> {
  await page.evaluate(() => {
    return (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      .getState()
      .stopRun()
  })
}

export async function setThemeViaStore(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate((nextTheme: 'dark' | 'light') => {
    ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      .getState()
      .setTheme(nextTheme)
  }, theme)
}

/** 真实的「看一场演示」入口（Welcome 页按钮）。 */
export function demoEntryButton(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('button', { name: /看一场演示/ }).first()
}

/** 点审批卡上的真实按钮（允许一次 / 拒绝）。 */
export async function clickPermissionCard(page: Page, action: 'once' | 'deny'): Promise<void> {
  const card = page.locator('.permission-card')
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  // 按钮文案含快捷键提示（「拒绝 Esc」），因此用包含匹配；卡内「拒绝」唯一
  const label = action === 'once' ? /允许一次/ : /拒绝/
  await card.getByRole('button', { name: label }).first().click()
}

/**
 * 跳过首次引导（测试里直接写 onboardingDone，并关闭引导层）。
 * 新数据目录首次启动 onboardingOpen=true，会盖住聊天界面；旅程测试需要先关掉。
 */
export async function dismissOnboarding(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any>; setState: (patch: Record<string, unknown>) => void } }).__morrowStore
    await store.getState().updateSettings({ onboardingDone: true })
    store.setState({ onboardingOpen: false })
  })
}

/** 等 run 真正开始（store.run 出现或 run_started 事件到达）。 */
export async function waitForRunStarted(page: Page, timeoutMs = 60_000): Promise<StoreSnapshot['run']> {
  return waitUntil(async () => (await readStore(page)).run, timeoutMs, 'run 开始')
}

/** 注册一个指向本地 Mock LLM 的 provider（test-mode 下 127.0.0.1 允许无 Key）。 */
export async function configureMockProvider(
  page: Page,
  baseUrl: string,
  providerId = 'mock-e2e',
  contextWindow = 32_000,
  supportsVision = false,
  contextOptions: number[] = [],
  reasoningEfforts: string[] = ['low', 'medium', 'high', 'xhigh', 'max']
): Promise<{ providerId: string; modelId: string }> {
  return page.evaluate(
    async (arg: {
      providerId: string
      baseUrl: string
      contextWindow: number
      supportsVision: boolean
      contextOptions: number[]
      reasoningEfforts: string[]
    }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const config = {
        id: arg.providerId,
        kind: 'openai-compat',
        name: '本地 Mock',
        baseUrl: arg.baseUrl,
        models: [
          {
            id: 'mock-model',
            label: 'Mock Model',
            contextWindow: arg.contextWindow,
            supportsTools: true,
            supportsReasoning: true,
            ...(arg.supportsVision ? { supportsVision: true } : {}),
            ...(arg.reasoningEfforts.length > 0 ? { reasoningEfforts: arg.reasoningEfforts } : {}),
            ...(arg.contextOptions.length > 0 ? { contextOptions: arg.contextOptions } : {}),
            reasoningStyle: 'effort',
            pricing: { inputPerMTok: 1, outputPerMTok: 2 }
          }
        ],
        apiKeyStored: false,
        enabled: true
      }
      await store.getState().saveProvider({ config })
      const settings = store.getState().settings as Record<string, any>
      const saved = (settings.providers as Array<Record<string, any>>).find((p) => p.id === arg.providerId)
      if (!saved) throw new Error('mock provider 保存失败')
      return { providerId: arg.providerId, modelId: 'mock-model' }
    },
    { providerId, baseUrl, contextWindow, supportsVision, contextOptions, reasoningEfforts }
  )
}

/** 新建会话并选为当前会话（不自动发消息）。 */
export async function createSession(
  page: Page,
  opts: {
    workspace: string
    providerId: string
    modelId: string
    permissionMode: 'auto' | 'ask' | 'read-only'
    title?: string
  }
): Promise<string> {
  return page.evaluate(
    async (arg: typeof opts) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const created = await window.morrow.session.create({
        workspace: arg.workspace,
        model: { providerId: arg.providerId, modelId: arg.modelId },
        permissionMode: arg.permissionMode,
        title: arg.title ?? 'E2E 会话'
      })
      if (!created.ok) throw new Error(`session.create 失败：${created.error.message}`)
      await store.getState().selectSession(created.data.id)
      const list = await window.morrow.session.list()
      if (list.ok) store.setState({ sessions: list.data })
      return created.data.id
    },
    opts
  )
}

/**
 * 从「设置 → 更多功能」打开一个真实功能面板。
 * 兼容旧测试里的工作台面板名，避免每处都记新文案。
 */
export async function openToolPanel(page: Page, label: string): Promise<void> {
  const titles: Record<string, string> = {
    技能库: '技能',
    记忆中心: '记忆',
    项目: '项目',
    连接器: '外部工具',
    全局搜索: '全局搜索',
    内置浏览器: '浏览器',
    浏览器: '浏览器',
    Git: '版本记录',
    'Git 工作台': '版本记录'
  }
  const title = titles[label] ?? label
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.waitFor({ state: 'visible' })
  await settings.getByRole('tab', { name: '更多功能' }).click()
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await settings.getByRole('button', { name: new RegExp(`^${escaped}`) }).click()
}
