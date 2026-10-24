/**
 * E2E 状态驱动工具：所有旅程测试都通过 test-mode 暴露的 zustand store
 * （`window.__morrowStore`，见 src/renderer/src/main.tsx）驱动真实 UI 与断言，
 * 而不是只测 DOM 快照。
 *
 * 为什么用 store：
 * - 它是渲染进程唯一事实源，store 的动作会走真实 preload → IPC → 主进程；
 * - UI 由 store 归约驱动，本文件同时断言 store 状态与 DOM 渲染，二者互证；
 * - 比点选择器稳定（UI 文案会迭代），但关键路径仍优先用真实 UI 点击（如审批按钮、演示入口）。
 */
import type { Page } from '@playwright/test'

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
            }))
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

/** 连续自动应答审批，直到 run 结束（返回被应答过的审批数量）。 */
export async function autoAnswerPermissions(
  page: Page,
  decision: 'once' | 'always' | 'deny',
  shouldStop: () => Promise<boolean>,
  timeoutMs = 180_000
): Promise<number> {
  const started = Date.now()
  let answered = 0
  while (Date.now() - started < timeoutMs) {
    if (await shouldStop()) return answered
    const state = await readStore(page)
    if (state.pendingPermission) {
      await page.evaluate(
        (arg: { decision: 'once' | 'always' | 'deny' }) =>
          (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
            .getState()
            .respondPermission(arg.decision),
        { decision }
      )
      answered += 1
    }
    await sleep(120)
  }
  return answered
}

/** 创建「demo 模型 + 指定权限模式」的会话并选为当前会话（不自动发消息）。 */
export async function createDemoSession(
  page: Page,
  permissionMode: 'auto' | 'ask' | 'read-only' = 'auto',
  title = 'E2E 演示会话'
): Promise<{ sessionId: string; workspace: string }> {
  return page.evaluate(
    async (arg: { permissionMode: 'auto' | 'ask' | 'read-only'; title: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const state = store.getState()
      const demoProvider = (state.settings.providers as Array<Record<string, any>>).find((p) => p.kind === 'demo')
      if (!demoProvider) throw new Error('settings 里没有 demo provider（内置演示模型）')
      const model = { providerId: demoProvider.id, modelId: demoProvider.models[0].id }
      const workspaceResult = await window.morrow.workspace.createDemo()
      if (!workspaceResult.ok) throw new Error(`workspace.createDemo 失败：${workspaceResult.error.message}`)
      const created = await window.morrow.session.create({
        workspace: workspaceResult.data.path,
        model,
        permissionMode: arg.permissionMode,
        title: arg.title
      })
      if (!created.ok) throw new Error(`session.create 失败：${created.error.message}`)
      await store.getState().selectSession(created.data.id)
      return { sessionId: created.data.id, workspace: workspaceResult.data.path }
    },
    { permissionMode, title }
  )
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
  supportsVision = false
): Promise<{ providerId: string; modelId: string }> {
  return page.evaluate(
    async (arg: { providerId: string; baseUrl: string; contextWindow: number; supportsVision: boolean }) => {
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
    { providerId, baseUrl, contextWindow, supportsVision }
  )
}

/**
 * 新建 UI 测试会话：使用设置里的默认真实模型（不需要 API Key，也不触发演示隔离限制）。
 * 只用于验证界面/文件/IPC，不发送消息时无需连接服务商。
 */
export async function createUiSession(
  page: Page,
  opts: {
    workspace: string
    permissionMode?: 'auto' | 'ask' | 'read-only'
    title?: string
  }
): Promise<string> {
  return page.evaluate(async (arg: typeof opts) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any>; setState: (patch: Record<string, unknown>) => void } }).__morrowStore
    const state = store.getState()
    const created = await window.morrow.session.create({
      workspace: arg.workspace,
      model: state.settings.defaultModel,
      permissionMode: arg.permissionMode ?? 'auto',
      title: arg.title ?? 'E2E 会话'
    })
    if (!created.ok) throw new Error(`session.create 失败：${created.error.message}`)
    await store.getState().selectSession(created.data.id)
    const list = await window.morrow.session.list()
    if (list.ok) store.setState({ sessions: list.data })
    return created.data.id
  }, opts)
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
 * 从「设置 → 功能与工具」打开一个真实功能面板。
 * 兼容旧测试里的工作台面板名，避免每处都记新文案。
 */
export async function openToolPanel(page: Page, label: string): Promise<void> {
  const titles: Record<string, string> = {
    技能库: '技能',
    记忆中心: '记忆',
    项目: '项目',
    连接器: '外部工具（MCP）',
    全局搜索: '全局搜索',
    内置浏览器: '浏览器',
    浏览器: '浏览器',
    Git: '版本历史（Git）',
    'Git 工作台': '版本历史（Git）'
  }
  const title = titles[label] ?? label
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.waitFor({ state: 'visible' })
  await settings.getByRole('tab', { name: '功能与工具' }).click()
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await settings.getByRole('button', { name: new RegExp(`^${escaped}`) }).click()
}
