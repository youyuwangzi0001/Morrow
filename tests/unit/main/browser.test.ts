/**
 * 合并后的 browser 组：内置浏览器、全局搜索、定时任务、Token 账本、终端、Git、输出守卫、模型同步、联网搜索。
 * 每个原文件各自包在 describe('<原文件名>') 中。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, mkdirSync, rmSync, utimesSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { type ToolCategory, type Artifact, type ChatMessage, type Session, type SessionMeta, type ProviderConfig, type WebSearchSettings } from '../../../src/shared/types'
import { type BrowserBridge, type BrowserState, BROWSER_LIMITS, BROWSER_PARTITION, BROWSER_WEB_PREFERENCES, checkBrowserUrl, isBrowserNavigationAllowed, isLoopbackHost, normalizeBrowserAddress, sanitizeBrowserBounds, setBrowserBridge, validateBrowserTarget } from '../../../src/core/browser-bridge'
import { BROWSER_TOOL_NAMES, browserTools } from '../../../src/core/tools/browser-tools'
import { EXTERNAL_ACTION_TOOLS, evaluatePermission, type PermissionPolicyContext, type PermissionTarget } from '../../../src/core/permissions'
import { makeToolContext } from '../core/helpers/tool-context'
import { makeTempWorkspace, makeTempDir } from '../core/helpers/workspace'
import { WorkspaceSearchService } from '../../../src/main/services/workspace-search-service'
import { ScheduleStore } from '../../../src/main/services/schedule-store'
import { type ScheduledTaskInput } from '../../../src/shared/schedules'
import { TokenActivityService } from '../../../src/main/services/token-activity'
import { TerminalManager } from '../../../src/main/services/terminal-manager'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { GitService } from '../../../src/main/services/git-service'
import { SensitiveGuard } from '../../../src/main/services/output-guard'
import { createServer, type Server } from 'node:http'
import { syncProviderModels } from '../../../src/main/services/model-sync'
import { type AddressInfo } from 'node:net'
import { WebSearchError, WebSearchService, parseBingResults } from '../../../src/main/services/web-search'
import { type SettingsStore } from '../../../src/main/services/settings-store'
import { executeTool } from '../../../src/core/tools/registry'


describe('browser.test.ts', () => {
/**
 * R10-C/K1：内置浏览器安全策略与自动化工具单测（不启动 Electron）。
 *
 * 覆盖：
 * - URL 白名单：仅 http/https；file/javascript/data/chrome 拒绝；localhost 允许；凭据 URL 拒绝；
 * - 远程页面 webPreferences 安全基线（sandbox/contextIsolation/无 Node/无 preload/独立分区）；
 * - bounds/target 参数安全化；
 * - 7 个 K1 工具的 happy path / 输入校验 / 只读拒绝 / 截图落盘 artifact / 错误归一化；
 * - 权限契约：read-only 直接拒绝；ask 逐次询问；auto 在接入 EXTERNAL_ACTION_TOOLS 后也逐次询问
 *   （Lead 集成接线点：permissions.ts 中加入 BROWSER_TOOL_NAMES）。
 */

const ONE_PX_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

type FakeCall = { method: string; args: unknown[] }

class FakeBridge implements BrowserBridge {
  calls: FakeCall[] = []
  readonly state: BrowserState = {
    open: true,
    visible: false,
    url: 'https://example.test/',
    title: '示例站点',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    error: null,
    automationActive: false,
    tabs: [],
    activeTabId: null
  }
  failWith: Error | null = null

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args })
    if (this.failWith) throw this.failWith
  }

  async open(url: string): Promise<BrowserState> {
    this.record('open', [url])
    return { ...this.state, url, title: '示例站点' }
  }
  async click(target: string) {
    this.record('click', [target])
    return { url: this.state.url, title: this.state.title, target: `button ${target}` }
  }
  async type(target: string, text: string, ctx: { submit?: boolean }) {
    this.record('type', [target, text, ctx.submit === true])
    return { url: this.state.url, title: this.state.title, target: `input ${target}` }
  }
  async read(ctx: { maxChars?: number }) {
    this.record('read', [ctx.maxChars])
    return { url: this.state.url, title: this.state.title, text: '页面正文内容'.repeat(50), truncated: false }
  }
  async screenshot() {
    this.record('screenshot', [])
    return { pngBase64: ONE_PX_PNG, width: 1, height: 1, url: this.state.url, title: this.state.title }
  }
  async back(): Promise<BrowserState> {
    this.record('back', [])
    return this.state
  }
  async forward(): Promise<BrowserState> {
    this.record('forward', [])
    return this.state
  }
  async reload(): Promise<BrowserState> {
    this.record('reload', [])
    return this.state
  }
  async scroll(_ctx: { runId: string }, deltaY: number) {
    this.record('scroll', [deltaY])
    return { url: this.state.url, title: this.state.title, target: `scroll ${deltaY}`, y: 0 }
  }
  async closeAutomation(): Promise<void> {
    this.record('closeAutomation', [])
  }
}

const tool = (name: string) => {
  const found = browserTools.find((candidate) => candidate.definition.name === name)
  if (!found) throw new Error(`缺少工具 ${name}`)
  return found
}

function permissionTarget(name: string): PermissionTarget {
  const definition = tool(name).definition
  return {
    toolName: definition.name,
    category: definition.category,
    baseRisk: definition.risk,
    input: {},
    title: definition.titleFor({})
  }
}

function policy(mode: PermissionPolicyContext['mode']): PermissionPolicyContext {
  return { mode, workspace: null, isDemo: false, sessionGrants: new Set<string>() }
}

/* ── URL 安全矩阵 ─────────────────────────────────────────────── */

describe('浏览器 URL 安全策略', () => {
  it('拒绝 file/javascript/data/chrome 等非 http(s) 协议', () => {
    for (const url of [
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<h1>x</h1>',
      'blob:https://example.com/abc',
      'chrome://settings',
      'about:blank',
      'ftp://example.com/a.txt'
    ]) {
      const check = checkBrowserUrl(url)
      expect(check.allowed, url).toBe(false)
      expect(check.reason, url).toBeTruthy()
    }
  })

  it('允许 http/https，localhost/127.0.0.1 正常放行', () => {
    for (const url of ['https://example.com', 'http://example.com/a?b=1#c', 'http://localhost:3000/', 'http://127.0.0.1:8080/x', 'http://[::1]:9000/']) {
      expect(checkBrowserUrl(url).allowed, url).toBe(true)
    }
  })

  it('拒绝携带账号密码的 URL、控制字符与超长 URL', () => {
    expect(checkBrowserUrl('https://user:pass@example.com/').allowed).toBe(false)
    expect(checkBrowserUrl('https://example.com/\u0000x').allowed).toBe(false)
    expect(checkBrowserUrl(`https://example.com/${'a'.repeat(BROWSER_LIMITS.maxUrlChars)}`).allowed).toBe(false)
    expect(checkBrowserUrl('').allowed).toBe(false)
    expect(checkBrowserUrl('not a url').allowed).toBe(false)
  })

  it('地址栏规范化：省略协议补 https，localhost 补 http', () => {
    expect(normalizeBrowserAddress('example.com').url).toBe('https://example.com/')
    expect(normalizeBrowserAddress('localhost:3000').url).toBe('http://localhost:3000/')
    expect(normalizeBrowserAddress('127.0.0.1:8080/a').url).toBe('http://127.0.0.1:8080/a')
    expect(normalizeBrowserAddress('file:///C:/x').allowed).toBe(false)
    expect(normalizeBrowserAddress('javascript:alert(1)').allowed).toBe(false)
  })

  it('页面内导航（will-navigate/redirect）只放行 http(s)', () => {
    expect(isBrowserNavigationAllowed('https://example.com/next')).toBe(true)
    expect(isBrowserNavigationAllowed('http://localhost:1234/')).toBe(true)
    expect(isBrowserNavigationAllowed('file:///C:/secret')).toBe(false)
    expect(isBrowserNavigationAllowed('javascript:void(0)')).toBe(false)
    expect(isBrowserNavigationAllowed('data:text/html,x')).toBe(false)
    expect(isBrowserNavigationAllowed('https://u:p@example.com/')).toBe(false)
  })

  it('loopback 判定', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('example.com')).toBe(false)
  })
})

/* ── 沙箱/权限基线 ───────────────────────────────────────────── */

describe('远程页面安全基线（BROWSER_WEB_PREFERENCES）', () => {
  it('sandbox + contextIsolation + 无 Node + 无 preload + 独立 session 分区', () => {
    expect(BROWSER_WEB_PREFERENCES.sandbox).toBe(true)
    expect(BROWSER_WEB_PREFERENCES.contextIsolation).toBe(true)
    expect(BROWSER_WEB_PREFERENCES.nodeIntegration).toBe(false)
    expect(BROWSER_WEB_PREFERENCES.nodeIntegrationInSubFrames).toBe(false)
    expect(BROWSER_WEB_PREFERENCES.webviewTag).toBe(false)
    expect(BROWSER_WEB_PREFERENCES.webSecurity).toBe(true)
    expect(BROWSER_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false)
    expect(BROWSER_WEB_PREFERENCES.partition).toBe(BROWSER_PARTITION)
    expect('preload' in BROWSER_WEB_PREFERENCES).toBe(false)
  })

  it('独立持久分区命名，和主应用 session 隔离', () => {
    expect(BROWSER_PARTITION.startsWith('persist:')).toBe(true)
    expect(BROWSER_PARTITION).not.toContain('default')
  })
})

/* ── bounds / target 安全化 ──────────────────────────────────── */

describe('bounds 与 target 安全化', () => {
  it('bounds 必须是有限、正尺寸、上限内的整数', () => {
    expect(sanitizeBrowserBounds({ x: 10, y: 20, width: 300, height: 200 })).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    expect(sanitizeBrowserBounds({ x: -5, y: 3.7, width: 100.2, height: 50.8 })).toEqual({ x: -5, y: 4, width: 100, height: 51 })
    expect(sanitizeBrowserBounds({ width: 0, height: 10 })).toBeNull()
    expect(sanitizeBrowserBounds({ width: -3, height: 10 })).toBeNull()
    expect(sanitizeBrowserBounds({ width: Number.NaN, height: 10 })).toBeNull()
    expect(sanitizeBrowserBounds({ width: 20_000, height: 10 })).toBeNull()
    expect(sanitizeBrowserBounds(null)).toBeNull()
    expect(sanitizeBrowserBounds('x')).toBeNull()
  })

  it('target 非空、限长、无控制字符', () => {
    expect(validateBrowserTarget('#submit').ok).toBe(true)
    expect(validateBrowserTarget('提交').ok).toBe(true)
    expect(validateBrowserTarget('').ok).toBe(false)
    expect(validateBrowserTarget('   ').ok).toBe(false)
    expect(validateBrowserTarget('a'.repeat(BROWSER_LIMITS.maxTargetChars + 1)).ok).toBe(false)
    expect(validateBrowserTarget('ab\u0000cd').ok).toBe(false)
  })
})

/* ── K1 工具 ─────────────────────────────────────────────────── */

describe('K1 浏览器自动化工具（fake bridge）', () => {
  let bridge: FakeBridge
  let ws: ReturnType<typeof makeTempWorkspace>
  let state: { todos: never[]; artifacts: import('../../../src/shared/types').Artifact[]; progressNotes: string[] }

  beforeEach(() => {
    bridge = new FakeBridge()
    setBrowserBridge(bridge)
    ws = makeTempWorkspace({})
    state = { todos: [], artifacts: [], progressNotes: [] }
  })

  afterEach(() => {
    setBrowserBridge(null)
    ws.cleanup()
  })

  const makeCtx = (overrides: Record<string, unknown> = {}) =>
    makeToolContext(ws, overrides as never, { todos: [], artifacts: state.artifacts, progressNotes: [] })

  it('导出 10 个工具名，全部为 exec + high 风险（只读模式由权限层直接拒绝）', () => {
    expect(BROWSER_TOOL_NAMES).toHaveLength(10)
    expect(new Set(BROWSER_TOOL_NAMES)).toEqual(new Set(browserTools.map((item) => item.definition.name)))
    for (const item of browserTools) {
      expect(item.definition.category).toBe('exec')
      expect(item.definition.risk).toBe('high')
      expect(item.definition.titleFor({ url: 'x', target: '按钮' })).not.toContain('undefined')
    }
  })

  it('browser_open：拒绝 file/javascript 等地址，且不触达 bridge', async () => {
    for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,x']) {
      const result = await tool('browser_open').execute({ url }, makeCtx())
      expect(result.ok, url).toBe(false)
      expect(result.error).toBeTruthy()
    }
    expect(bridge.calls).toHaveLength(0)
  })

  it('browser_open：合法地址交给 bridge，返回标题与 URL', async () => {
    const result = await tool('browser_open').execute({ url: 'example.com' }, makeCtx())
    expect(result.ok).toBe(true)
    expect(bridge.calls[0]).toMatchObject({ method: 'open' })
    expect(String(result.output)).toContain('示例站点')
    expect(String(result.output)).toContain('https://example.com/')
  })

  it('browser_click / browser_type：输入校验 + 正常调用', async () => {
    expect((await tool('browser_click').execute({ target: '' }, makeCtx())).ok).toBe(false)
    const clicked = await tool('browser_click').execute({ target: '#btn' }, makeCtx())
    expect(clicked.ok).toBe(true)
    expect(bridge.calls.at(-1)).toMatchObject({ method: 'click', args: ['#btn'] })

    expect((await tool('browser_type').execute({ target: '#input', text: '' }, makeCtx())).ok).toBe(false)
    expect((await tool('browser_type').execute({ target: '#input', text: 'x'.repeat(BROWSER_LIMITS.maxTypeChars + 1) }, makeCtx())).ok).toBe(false)
    const typed = await tool('browser_type').execute({ target: '#input', text: '你好', submit: true }, makeCtx())
    expect(typed.ok).toBe(true)
    expect(bridge.calls.at(-1)).toMatchObject({ method: 'type', args: ['#input', '你好', true] })
  })

  it('browser_read：返回标题/URL/正文，并做字符上限', async () => {
    const result = await tool('browser_read').execute({ max_chars: 500 }, makeCtx())
    expect(result.ok).toBe(true)
    expect(String(result.output)).toContain('示例站点')
    expect(String(result.output)).toContain('https://example.test/')
    expect(bridge.calls.at(-1)).toMatchObject({ method: 'read' })
  })

  it('browser_screenshot：PNG 写入工作区并注册 artifact', async () => {
    const result = await tool('browser_screenshot').execute({}, makeCtx())
    expect(result.ok).toBe(true)
    const meta = result.meta as { path: string; width: number; height: number; artifactId: string }
    expect(meta.path).toContain(join('.morrow', 'browser'))
    expect(existsSync(meta.path)).toBe(true)
    const buffer = readFileSync(meta.path)
    expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a') // PNG signature
    expect(buffer.length).toBeGreaterThan(50)
    expect(meta.width).toBe(1)
    expect(state.artifacts).toHaveLength(1)
    expect(state.artifacts[0]).toMatchObject({ kind: 'file', path: meta.path })
    expect(state.artifacts[0].title).toContain('网页截图')
  })

  it('browser_screenshot：没有工作区时明确失败，不写盘', async () => {
    const result = await tool('browser_screenshot').execute({}, makeCtx({ workspace: null }))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('工作区')
  })

  it('browser_back / browser_forward：正常调用与错误归一化', async () => {
    const back = await tool('browser_back').execute({}, makeCtx())
    expect(back.ok).toBe(true)
    expect(bridge.calls.at(-1)).toMatchObject({ method: 'back' })
    bridge.failWith = new Error('已经到第一页，无法后退。')
    const failed = await tool('browser_back').execute({}, makeCtx())
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('浏览器操作失败')
    expect(failed.error).toContain('无法后退')
  })

  it('browser_reload / browser_scroll / browser_close：真实转发并夹取滚动范围', async () => {
    const reload = await tool('browser_reload').execute({}, makeCtx())
    expect(reload.ok).toBe(true)
    expect(bridge.calls.at(-1)).toMatchObject({ method: 'reload' })

    const down = await tool('browser_scroll').execute({ direction: 'down', amount: 99999 }, makeCtx())
    expect(down.ok).toBe(true)
    expect(bridge.calls.at(-1)).toMatchObject({ method: 'scroll', args: [4000] })

    const up = await tool('browser_scroll').execute({ direction: 'up', amount: 200 }, makeCtx())
    expect(up.ok).toBe(true)
    expect(bridge.calls.at(-1)).toMatchObject({ method: 'scroll', args: [-200] })

    const closed = await tool('browser_close').execute({}, makeCtx())
    expect(closed.ok).toBe(true)
    expect(bridge.calls.at(-1)).toMatchObject({ method: 'closeAutomation' })
  })

  it('只读上下文（集群成员）一律拒绝浏览器操作', async () => {
    for (const name of ['browser_open', 'browser_screenshot', 'browser_back']) {
      const result = await tool(name).execute(
        name === 'browser_open' ? { url: 'https://example.com' } : {},
        makeCtx({ readOnly: true })
      )
      expect(result.ok, name).toBe(false)
      expect(result.error).toContain('只读')
    }
    expect(bridge.calls).toHaveLength(0)
  })

  it('bridge 未注入时给出可读错误（主进程未接线场景）', async () => {
    setBrowserBridge(null)
    const result = await tool('browser_open').execute({ url: 'https://example.com' }, makeCtx())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('浏览器自动化不可用')
    expect(result.hint).toContain('主进程')
  })
})

/* ── 权限契约 ────────────────────────────────────────────────── */

describe('浏览器工具权限契约（ask/auto 都必须审批）', () => {
  it('read-only：全部浏览器工具直接拒绝（category=exec）', () => {
    for (const name of BROWSER_TOOL_NAMES) {
      const gate = evaluatePermission(permissionTarget(name), policy('read-only'))
      expect(gate.action, name).toBe('deny')
    }
  })

  it('ask：被动浏览直接放行，点击/输入仍需审批', () => {
    const passive = new Set(['browser_open', 'browser_read', 'browser_screenshot', 'browser_reload', 'browser_scroll', 'browser_close'])
    for (const name of BROWSER_TOOL_NAMES) {
      const gate = evaluatePermission(permissionTarget(name), policy('ask'))
      expect(gate.action, name).toBe(passive.has(name) ? 'allow' : 'ask')
      if (gate.action === 'ask') expect(gate.allowAlways).toBe(false)
    }
  })

  it('auto（完全访问）：接入 EXTERNAL_ACTION_TOOLS 后直接执行', () => {
    const external = EXTERNAL_ACTION_TOOLS as Set<string>
    const added: string[] = []
    try {
      for (const name of BROWSER_TOOL_NAMES) {
        if (!external.has(name)) {
          external.add(name)
          added.push(name)
        }
      }
      for (const name of BROWSER_TOOL_NAMES) {
        const gate = evaluatePermission(permissionTarget(name), policy('auto'))
        expect(gate.action, name).toBe('allow')
      }
    } finally {
      for (const name of added) external.delete(name)
    }
  })
})
})

describe('search.test.ts', () => {
/**
 * R10-I 全局搜索服务单测（不依赖 Electron）：
 * 中文/标题/正文/artifact、忽略目录/二进制/超大文件、工作区隔离、增量更新、ranking/片段/limit/状态。
 */

function textMessage(id: string, role: ChatMessage['role'], text: string): ChatMessage {
  return { id, role, content: [{ type: 'text', text }], createdAt: 1 }
}

function artifact(id: string, title: string, content: string): Artifact {
  return { id, title, kind: 'markdown', content, createdAt: 1, updatedAt: 1 }
}

function makeSession(input: {
  id: string
  title: string
  workspace: string | null
  messages?: ChatMessage[]
  artifacts?: Artifact[]
}): Session {
  return {
    id: input.id,
    title: input.title,
    workspace: input.workspace,
    model: { providerId: 'mock', modelId: 'mock' },
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 10,
    messageCount: input.messages?.length ?? 0,
    messages: input.messages ?? [],
    todos: [],
    artifacts: input.artifacts ?? [],
    usage: { inputTokens: 0, outputTokens: 0 }
  }
}

function metaOf(session: Session): SessionMeta {
  return {
    id: session.id,
    title: session.title,
    workspace: session.workspace,
    model: session.model,
    permissionMode: session.permissionMode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length
  }
}

function makeHarness() {
  const sessions = new Map<string, Session>()
  const workspaces: string[] = []
  let now = 10_000
  let revision = 0
  const service = new WorkspaceSearchService(
    {
      listSessions: () => [...sessions.values()].map(metaOf),
      getSession: (id) => sessions.get(id) ?? null,
      listWorkspaces: () => workspaces,
      getSessionRevision: () => revision,
      now: () => now
    },
    { autoRefreshMs: 1500 }
  )
  return {
    sessions,
    workspaces,
    service,
    advance: (ms: number) => {
      now += ms
    },
    touch: () => {
      revision += 1
    }
  }
}

function write(root: string, relative: string, content: string | Buffer): string {
  const absolute = join(root, relative)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
  return absolute
}

describe('全局搜索：索引与查询', () => {
  it('中文查询命中会话标题/消息正文、文件路径/内容、artifact，并带片段高亮', async () => {
    const root = makeTempDir('search-ws-')
    try {
      write(root, 'docs/预算说明.md', '这是 2026 年 Q3 的预算说明，金额上限 5 万元。')
      write(root, 'notes.txt', '普通内容')
      const session = makeSession({
        id: 's1',
        title: 'Q3 预算复盘',
        workspace: root,
        messages: [textMessage('m1', 'user', '帮我检查预算是否超限'), textMessage('m2', 'assistant', '预算没有超限。')],
        artifacts: [artifact('a1', '预算报告', '总预算 48000 元，未超过上限。')]
      })
      const harness = makeHarness()
      harness.sessions.set(session.id, session)
      harness.workspaces.push(root)
      await harness.service.start()

      const result = await harness.service.search({ q: '预算', workspace: root, limit: 20 })
      expect(result.total).toBeGreaterThanOrEqual(3)
      expect(result.groups.sessions[0]?.title).toContain('预算')
      expect(result.groups.sessions[0]?.highlights.length).toBeGreaterThan(0)
      expect(result.groups.files.some((hit) => hit.path === 'docs/预算说明.md')).toBe(true)
      expect(result.groups.artifacts[0]?.title).toBe('预算报告')
      expect(result.tookMs).toBeGreaterThanOrEqual(0)
      expect(result.index.ready).toBe(true)
      expect(result.index.sessions).toBe(1)
      expect(result.index.files).toBeGreaterThanOrEqual(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('文件内容命中给出行号；文件名命中优先于内容命中', async () => {
    const root = makeTempDir('search-rank-')
    try {
      write(root, '预算-报告.md', '这里只提到一次预算。')
      write(root, 'other.md', '预算 预算 预算 预算，但文件名不相关。')
      const harness = makeHarness()
      harness.workspaces.push(root)
      await harness.service.start()
      const result = await harness.service.search({ q: '预算', workspace: root, limit: 10 })
      const files = result.groups.files
      expect(files.length).toBeGreaterThanOrEqual(2)
      expect(files[0].path).toContain('预算-报告.md')
      const contentHit = files.find((hit) => hit.path === 'other.md')
      expect(contentHit?.line).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('同分会话按最近更新优先', async () => {
    const harness = makeHarness()
    harness.advance(10 * 86_400_000)
    const now = 10_000 + 10 * 86_400_000
    const newer = makeSession({
      id: 's_new',
      title: '预算 新会话',
      workspace: null,
      messages: [textMessage('m_new', 'user', '预算 新内容')]
    })
    const older = makeSession({
      id: 's_old',
      title: '预算 旧会话',
      workspace: null,
      messages: [textMessage('m_old', 'user', '预算 旧内容')]
    })
    newer.updatedAt = now
    older.updatedAt = now - 6 * 86_400_000
    harness.sessions.set(newer.id, newer)
    harness.sessions.set(older.id, older)
    await harness.service.start()
    const result = await harness.service.search({ q: '预算', limit: 10 })
    expect(result.groups.sessions.map((hit) => hit.id)).toEqual(['s_new', 's_old'])
  })

  it('忽略 node_modules/.git/Morrow Data/二进制/超大文件', async () => {
    const root = makeTempDir('search-ignore-')
    try {
      write(root, 'src/app.ts', 'const 预算 = 1')
      write(root, 'node_modules/pkg/index.js', '预算 不应该被索引')
      write(root, '.git/config', '预算 不应该被索引')
      write(root, 'Morrow Data/secret.txt', '预算 不应该被索引')
      write(root, 'binary.bin', Buffer.from([0x00, 0x01, 0x02, 0x03]))
      write(root, 'huge.txt', `${'预算 '.repeat(200_000)}`)
      const harness = makeHarness()
      harness.workspaces.push(root)
      await harness.service.start()
      const result = await harness.service.search({ q: '预算', workspace: root, limit: 20 })
      const paths = result.groups.files.map((hit) => hit.path)
      expect(paths).toContain('src/app.ts')
      expect(paths?.some((path) => path?.includes('node_modules'))).toBe(false)
      expect(paths?.some((path) => path?.startsWith('.git/'))).toBe(false)
      expect(paths?.some((path) => path?.includes('Morrow Data'))).toBe(false)
      expect(paths?.some((path) => path?.includes('binary.bin'))).toBe(false)
      expect(paths?.some((path) => path?.includes('huge.txt'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('工作区隔离：限定工作区不返回其它工作区的文件/会话/artifact', async () => {
    const rootA = makeTempDir('search-a-')
    const rootB = makeTempDir('search-b-')
    try {
      write(rootA, 'a.md', '预算 A 工作区')
      write(rootB, 'b.md', '预算 B 工作区（不应出现在 A 查询）')
      const sessionA = makeSession({ id: 'sa', title: '预算 A 会话', workspace: rootA, messages: [textMessage('ma', 'user', '预算 A')] })
      const sessionB = makeSession({
        id: 'sb',
        title: '预算 B 会话',
        workspace: rootB,
        messages: [textMessage('mb', 'user', '预算 B')],
        artifacts: [artifact('ab', '预算 B 报告', '预算 B')]
      })
      const harness = makeHarness()
      harness.sessions.set('sa', sessionA)
      harness.sessions.set('sb', sessionB)
      harness.workspaces.push(rootA, rootB)
      await harness.service.start()

      const resultA = await harness.service.search({ q: '预算', workspace: rootA, limit: 20 })
      expect(resultA.groups.files.every((hit) => hit.absolutePath?.startsWith(rootA))).toBe(true)
      expect(resultA.groups.sessions.every((hit) => hit.sessionId === 'sa')).toBe(true)
      expect(resultA.groups.artifacts.every((hit) => hit.sessionId === 'sa')).toBe(true)

      // 不带工作区：全局搜索，文件/会话/artifact 覆盖两个工作区
      const global = await harness.service.search({ q: '预算', limit: 20 })
      expect(global.groups.files.length).toBeGreaterThanOrEqual(2)
      expect(global.groups.files.some((hit) => hit.absolutePath?.startsWith(rootA))).toBe(true)
      expect(global.groups.files.some((hit) => hit.absolutePath?.startsWith(rootB))).toBe(true)
      expect(global.groups.sessions.length).toBe(2)
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })

  it('增量更新：新增/修改/删除文件与会话刷新后可搜到/移除；limit 生效', async () => {
    const root = makeTempDir('search-inc-')
    try {
      write(root, 'old.md', '旧内容 预算')
      const harness = makeHarness()
      harness.workspaces.push(root)
      await harness.service.start()
      expect((await harness.service.search({ q: '新增', workspace: root })).total).toBe(0)

      // 新增文件 + 刷新
      write(root, 'new.md', '新增内容 预算')
      await harness.service.refreshWorkspace(root)
      expect((await harness.service.search({ q: '新增', workspace: root })).groups.files).toHaveLength(1)

      // 修改文件内容 + 推进时间（避免 mtime 同毫秒）+ 刷新
      await new Promise((resolve) => setTimeout(resolve, 20))
      write(root, 'new.md', '替换后的内容')
      await harness.service.refreshWorkspace(root)
      expect((await harness.service.search({ q: '替换', workspace: root })).total).toBe(1)
      expect((await harness.service.search({ q: '新增', workspace: root })).total).toBe(0)

      // 删除文件 + 刷新
      rmSync(join(root, 'old.md'))
      await harness.service.refreshWorkspace(root)
      expect((await harness.service.search({ q: '旧内容', workspace: root })).total).toBe(0)

      // 会话增量：新增消息后刷新
      const session = makeSession({ id: 'sx', title: '普通会话', workspace: root, messages: [textMessage('m1', 'user', '第一句')] })
      harness.sessions.set('sx', session)
      await harness.service.refreshSession('sx')
      expect((await harness.service.search({ q: '第一句', workspace: root })).groups.sessions).toHaveLength(1)
      session.messages.push(textMessage('m2', 'user', '新增关键句'))
      session.updatedAt = 20
      await harness.service.refreshSession('sx')
      expect((await harness.service.search({ q: '新增关键句', workspace: root })).groups.sessions).toHaveLength(1)

      // limit 每组上限
      for (let i = 0; i < 12; i += 1) write(root, `many-${i}.md`, `批量 预算 ${i}`)
      await harness.service.refreshWorkspace(root)
      const limited = await harness.service.search({ q: '预算', workspace: root, limit: 3 })
      expect(limited.groups.files.length).toBeLessThanOrEqual(1)
      expect(limited.total).toBeLessThanOrEqual(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('查询前自动增量刷新（保存/工具完成无需显式通知）', async () => {
    const root = makeTempDir('search-auto-')
    try {
      write(root, 'a.md', '初始')
      const harness = makeHarness()
      harness.workspaces.push(root)
      await harness.service.start()
      write(root, 'b.md', '新保存的文件 自动可见')
      harness.advance(2000)
      const result = await harness.service.search({ q: '自动可见', workspace: root })
      expect(result.groups.files).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('会话版本变化时绕过刷新节流，新建会话可立即搜到', async () => {
    const harness = makeHarness()
    const root = makeTempDir('search-revision-')
    try {
      harness.workspaces.push(root)
      await harness.service.start()
      const session = makeSession({
        id: 'srev',
        title: '版本感知会话',
        workspace: root,
        messages: [textMessage('m1', 'user', '版本感知标记词')]
      })
      harness.sessions.set(session.id, session)
      harness.touch()
      const result = await harness.service.search({ q: '版本感知标记词', workspace: root })
      expect(result.groups.sessions).toHaveLength(1)
      expect(result.groups.sessions[0].sessionId).toBe('srev')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('片段高亮在空白归一化后仍精确覆盖命中词', async () => {
    const root = makeTempDir('search-highlight-')
    try {
      write(root, 'spacing.md', '前文    预算\n\n  后面还有内容')
      const harness = makeHarness()
      harness.workspaces.push(root)
      await harness.service.start()
      const result = await harness.service.search({ q: '预算', workspace: root })
      const hit = result.groups.files.find((item) => item.path === 'spacing.md')
      expect(hit).toBeTruthy()
      const range = hit!.highlights[0]
      expect(hit!.snippet.slice(range.start, range.end)).toBe('预算')
      expect(hit!.snippet).toContain('预算')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('会话删除后 refreshSession 立即移除搜索索引', async () => {
    const harness = makeHarness()
    const root = makeTempDir('search-delete-')
    try {
      const session = makeSession({
        id: 'sdel',
        title: '待删除会话',
        workspace: root,
        messages: [textMessage('m1', 'user', '唯一删除标记词')]
      })
      harness.sessions.set(session.id, session)
      harness.workspaces.push(root)
      await harness.service.start()
      expect((await harness.service.search({ q: '唯一删除标记词', workspace: root })).groups.sessions).toHaveLength(1)

      harness.sessions.delete(session.id)
      await harness.service.refreshSession(session.id)
      const after = await harness.service.search({ q: '唯一删除标记词', workspace: root })
      expect(after.groups.sessions).toHaveLength(0)
      expect(after.groups.artifacts).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('不再被引用的工作区会从文件索引中清理', async () => {
    const root = makeTempDir('search-prune-')
    try {
      write(root, 'stale.md', '过期工作区内容 海上明月')
      const harness = makeHarness()
      harness.workspaces.push(root)
      await harness.service.start()
      expect(harness.service.status().files).toBeGreaterThan(0)

      harness.workspaces.length = 0
      harness.advance(2_000)
      // 不带 workspace 查询不会重新请求该目录，刷新时应清理不再被引用的索引
      await harness.service.search({ q: '海上明月' })
      expect(harness.service.status().files).toBe(0)
      expect(harness.service.status().workspaces).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('启动后新增工作区：全局搜索无需先传 workspace 即可搜到文件', async () => {
    const root = makeTempDir('search-late-ws-')
    try {
      write(root, 'late.md', '启动后新增的工作区内容 晚到标记')
      const harness = makeHarness()
      await harness.service.start()
      // 模拟应用启动后新建会话/选择新文件夹
      harness.workspaces.push(root)
      harness.sessions.set('s_late', makeSession({ id: 's_late', title: '晚到会话', workspace: root }))
      const result = await harness.service.search({ q: '晚到标记', limit: 20 })
      expect(result.groups.files.some((hit) => hit.absolutePath === join(root, 'late.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('状态与空查询', async () => {
    const harness = makeHarness()
    const empty = await harness.service.search({ q: '   ' })
    expect(empty.total).toBe(0)
    expect(empty.index.ready).toBe(true)
    expect(empty.index.workspaces).toEqual([])
    const status = harness.service.status()
    expect(status.building).toBe(false)
  })
})
})

describe('schedule-store.test.ts', () => {
const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime()
}

function setup(): { store: ScheduleStore; dir: string; workspace: string } {
  const dir = makeTempDir('schedules-')
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  cleanups.push(dir)
  const now = at(2026, 10, 20, 10, 30)
  const store = new ScheduleStore({ dir: join(dir, 'schedules'), now: () => now })
  return { store, dir, workspace }
}

function input(workspace: string): ScheduledTaskInput {
  return {
    title: '每周整理项目',
    prompt: '整理本周新增文件与改动，写一份简短周报。',
    schedule: { kind: 'daily', time: '09:00' },
    workspace,
    permissionMode: 'read-only',
    enabled: true
  }
}

describe('ScheduleStore', () => {
  it('创建任务：计算下一次执行、持久化，并在重启后可读取', () => {
    const { store, dir, workspace } = setup()
    const task = store.create(input(workspace))
    expect(task.lastStatus).toBe('never')
    expect(task.nextRunAt).toBe(at(2026, 10, 21, 9))
    expect(existsSync(join(dir, 'schedules', 'tasks.json'))).toBe(true)
    expect(readFileSync(join(dir, 'schedules', 'tasks.json'), 'utf8')).toContain('每周整理项目')

    const reloaded = new ScheduleStore({ dir: join(dir, 'schedules'), now: () => at(2026, 10, 20, 12) })
    const saved = reloaded.list()[0]
    expect(saved).toMatchObject({ id: task.id, workspace, nextRunAt: at(2026, 10, 21, 9), enabled: true })
  })

  it('暂停/启用会重新安排下一次；修改规则会重算', () => {
    const { store, workspace } = setup()
    const task = store.create(input(workspace))
    const paused = store.setEnabled(task.id, false)
    expect(paused.enabled).toBe(false)
    expect(paused.nextRunAt).toBeNull()
    const enabled = store.setEnabled(task.id, true)
    expect(enabled.nextRunAt).toBe(at(2026, 10, 21, 9))

    const updated = store.update(task.id, {
      ...input(workspace),
      schedule: { kind: 'weekly', time: '18:00', weekday: 5 }
    })
    expect(updated.schedule.kind).toBe('weekly')
    expect(updated.nextRunAt).toBe(at(2026, 10, 23, 18))
  })

  it('运行标记：运行中 → 成功后为每天任务排下一次；一次性任务执行后自动停用', () => {
    const { store, workspace } = setup()
    const daily = store.create(input(workspace))
    store.markRunning(daily.id, 'session-1')
    expect(store.get(daily.id)).toMatchObject({ lastStatus: 'running', lastSessionId: 'session-1' })
    const finished = store.markFinished(daily.id, 'success')
    expect(finished).toMatchObject({ lastStatus: 'success', nextRunAt: at(2026, 10, 21, 9), enabled: true })

    const once = store.create({
      ...input(workspace),
      schedule: { kind: 'once', time: '12:00', date: '2026-10-20' }
    })
    expect(once.enabled).toBe(true)
    const done = store.markFinished(once.id, 'success')
    expect(done.enabled).toBe(false)
    expect(done.nextRunAt).toBeNull()
  })

  it('立即运行不推进下一次自动执行时间', () => {
    const { store, workspace } = setup()
    const task = store.create(input(workspace))
    store.markRunning(task.id, 'session-manual')
    const done = store.markFinished(task.id, 'success', { manual: true })
    expect(done.nextRunAt).toBe(at(2026, 10, 21, 9))
    expect(done.lastStatus).toBe('success')
  })

  it('运行中被暂停：完成后保持暂停，不会写回下一次执行时间', () => {
    const { store, workspace } = setup()
    const task = store.create(input(workspace))
    store.markRunning(task.id, 'session-paused')
    store.setEnabled(task.id, false)
    const done = store.markFinished(task.id, 'success')
    expect(done.enabled).toBe(false)
    expect(done.nextRunAt).toBeNull()
  })

  it('启动恢复：运行中的遗留任务记为失败；错过太久的任务记为 missed 并顺延', () => {
    const { store, dir, workspace } = setup()
    const interrupted = store.create(input(workspace))
    store.markRunning(interrupted.id, 'session-x')
    const missed = store.create({
      ...input(workspace),
      title: '已经错过的任务',
      schedule: { kind: 'daily', time: '09:00' }
    })
    // 把下一次执行改到 3 小时前，模拟应用关闭了一段时间
    const raw = JSON.parse(readFileSync(join(dir, 'schedules', 'tasks.json'), 'utf8')) as {
      tasks: Array<Record<string, unknown>>
    }
    for (const task of raw.tasks) {
      if (task.id === missed.id) task.nextRunAt = at(2026, 10, 20, 7, 30)
    }
    // 重新写回后由新实例加载（ScheduleStore 有内存缓存，直接构造新实例）
    writeFileSync(join(dir, 'schedules', 'tasks.json'), JSON.stringify({ version: 1, tasks: raw.tasks }), 'utf8')
    const reloaded = new ScheduleStore({ dir: join(dir, 'schedules'), now: () => at(2026, 10, 20, 10, 30) })
    expect(reloaded.recoverInterrupted()).toBe(true)
    expect(reloaded.recoverMissed(60 * 60 * 1000)).toBe(1)
    expect(reloaded.get(interrupted.id)?.lastStatus).toBe('error')
    expect(reloaded.get(missed.id)?.lastStatus).toBe('missed')
    expect(reloaded.get(missed.id)?.nextRunAt).toBe(at(2026, 10, 21, 9))
  })

  it('校验工作区、必填项与数量上限', () => {
    const { store, workspace } = setup()
    expect(() => store.create({ ...input(workspace), title: ' ' })).toThrow('任务名称')
    expect(() => store.create({ ...input(workspace), prompt: '' })).toThrow('任务内容')
    expect(() => store.create({ ...input(join(workspace, 'missing')) })).toThrow('文件夹不存在')
    expect(() =>
      store.create({ ...input(workspace), schedule: { kind: 'daily', time: '24:00' } })
    ).toThrow('时间格式')
  })

  it('删除任务只移除安排，不影响已产生的会话（store 不持有会话）', () => {
    const { store, workspace } = setup()
    const task = store.create(input(workspace))
    store.remove(task.id)
    expect(store.list()).toHaveLength(0)
    expect(() => store.remove(task.id)).toThrow('找不到')
  })

  it('清除全部对话后移除任务对会话的引用与运行历史，但保留定时安排', () => {
    const { store, workspace } = setup()
    const task = store.create(input(workspace))
    store.markRunning(task.id, 'session-cleared')
    store.markFinished(task.id, 'success')
    const before = store.get(task.id)!
    expect(before.lastSessionId).toBe('session-cleared')
    expect(before.nextRunAt).not.toBeNull()

    expect(store.clearSessionReferences()).toBe(1)
    const after = store.get(task.id)!
    expect(after.lastSessionId).toBeUndefined()
    expect(after.lastRunAt).toBeNull()
    expect(after.lastStatus).toBe('never')
    expect(after.nextRunAt).toBe(before.nextRunAt)
    expect(store.clearSessionReferences()).toBe(0)
  })
})
})

describe('token-activity.test.ts', () => {
/**
 * Token 活动账本：真实 usage 记录、按日本地聚合、估算标记、历史回填幂等。
 */

function at(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour).getTime()
}

describe('TokenActivityService', () => {
  it('按本地日期聚合精确/估算 token，并正确计算今天、近7天与累计', () => {
    const dir = makeTempDir('token-activity-')
    try {
      const now = at(2026, 10, 20)
      const service = new TokenActivityService(dir, { now: () => now })
      service.record({ at: at(2026, 10, 14), inputTokens: 100, outputTokens: 50, sessionId: 's1' })
      service.record({
        at: at(2026, 10, 20),
        inputTokens: 20,
        outputTokens: 10,
        estimatedInputTokens: 30,
        estimatedOutputTokens: 5,
        sessionId: 's2'
      })
      const summary = service.summary(now)
      expect(summary.days).toHaveLength(365)
      const today = summary.days[summary.days.length - 1]
      expect(today).toMatchObject({
        date: '2026-10-20',
        inputTokens: 20,
        outputTokens: 10,
        estimatedTokens: 35,
        totalTokens: 65,
        requests: 1
      })
      expect(summary.today).toBe(65)
      expect(summary.week).toBe(215)
      expect(summary.yearTotal).toBe(215)
      expect(summary.total).toBe(215)
      expect(summary.activeDays).toBe(2)
      expect(summary.estimatedTokens).toBe(35)

      const reloaded = new TokenActivityService(dir, { now: () => now })
      expect(reloaded.summary(now)).toMatchObject({ total: 215, today: 65, estimatedTokens: 35 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('缓存读取只是输入明细，总量不重复累加', () => {
    const dir = makeTempDir('token-activity-cache-')
    try {
      const now = at(2026, 10, 20)
      const service = new TokenActivityService(dir, { now: () => now })
      service.record({ at: now, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, sessionId: 's1' })
      const summary = service.summary(now)
      const today = summary.days[summary.days.length - 1]
      expect(today).toMatchObject({
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 800,
        totalTokens: 1200
      })
      expect(summary.today).toBe(1200)
      expect(summary.total).toBe(1200)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('历史会话只回填一次，演示会话不计数', () => {
    const dir = makeTempDir('token-activity-legacy-')
    try {
      const now = at(2026, 10, 20)
      const service = new TokenActivityService(dir, { now: () => now })
      const sessions = [
        {
          id: 'legacy-real',
          updatedAt: at(2026, 10, 18),
          model: { providerId: 'deepseek' },
          usage: { inputTokens: 1000, outputTokens: 200 }
        },
        {
          id: 'legacy-demo',
          updatedAt: at(2026, 10, 18),
          model: { providerId: 'demo' },
          usage: { inputTokens: 9999, outputTokens: 9999 }
        }
      ]
      service.syncLegacy(sessions)
      expect(service.summary(now).total).toBe(1200)
      service.syncLegacy(sessions)
      expect(service.summary(now).total).toBe(1200)

      // 回填过的会话后续真实运行只记录增量，不再重复累计
      service.record({ at: now, inputTokens: 100, outputTokens: 20, sessionId: 'legacy-real' })
      expect(service.summary(now).total).toBe(1320)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('损坏账本不会阻断启动，重新记录后恢复', () => {
    const dir = makeTempDir('token-activity-corrupt-')
    try {
      const service = new TokenActivityService(dir, { now: () => at(2026, 10, 20) })
      service.record({ at: at(2026, 10, 20), inputTokens: 10, outputTokens: 5, sessionId: 's1' })
      const file = join(dir, 'usage', 'token-activity.json')
      writeFileSync(file, '{bad json', 'utf8')
      const recovered = new TokenActivityService(dir, { now: () => at(2026, 10, 20) })
      expect(recovered.summary().total).toBe(0)
      recovered.record({ at: at(2026, 10, 20), inputTokens: 7, outputTokens: 3, sessionId: 's2' })
      expect(recovered.summary().total).toBe(10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
})

describe('terminal.test.ts', () => {
/**
 * P0-1 终端/后台任务：持久 shell 输入输出、后台任务日志/退出、一次性命令。
 * 使用本机 PowerShell/sh，不依赖 Electron。
 */

const managers: TerminalManager[] = []
afterEach(() => {
  while (managers.length) managers.pop()?.dispose()
})

function makeManager(): TerminalManager {
  const manager = new TerminalManager()
  managers.push(manager)
  return manager
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('等待终端输出超时')
}

describe('TerminalManager', () => {
  it('persistent shell keeps stdin/stdout and can be stopped', async () => {
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const shell = manager.createShell(ws.root, '测试终端', 'pwsh')
      expect(shell.kind).toBe('shell')
      expect(shell.status).toBe('running')
      manager.write(shell.id, "Write-Output 'hello-terminal'")
      await waitFor(() => manager.read(shell.id).output.includes('hello-terminal'))
      manager.write(shell.id, "Write-Output 'second-line'")
      await waitFor(() => manager.read(shell.id).output.includes('second-line'))
      manager.stop(shell.id)
      await waitFor(() => manager.get(shell.id)?.status === 'exited')
    } finally {
      ws.cleanup()
    }
  })

  it('shell runs inside a real PTY and accepts resize', async () => {
    if (process.platform !== 'win32') return
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const shell = manager.createShell(ws.root, 'PTY 检测', 'pwsh')
      expect(shell.pid).toBeGreaterThan(0)
      manager.resize(shell.id, 100, 30)
      manager.write(
        shell.id,
        "if ([Console]::IsOutputRedirected) { 'PTY_' + 'MISSING' } else { 'PTY_' + 'ACTIVE' }"
      )
      await waitFor(() => manager.read(shell.id).output.includes('PTY_ACTIVE'))
      expect(manager.read(shell.id).output).not.toContain('PTY_MISSING')
      manager.stop(shell.id)
      await waitFor(() => manager.get(shell.id)?.status === 'exited')
      manager.dispose()
      // Windows 上 ConPTY 宿主释放工作目录比 onExit 稍晚
      await new Promise((resolve) => setTimeout(resolve, 900))
    } finally {
      try {
        ws.cleanup()
      } catch (err) {
        // PTY 句柄释放有延迟时，临时目录留给系统清理
        if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
      }
    }
  })

  it('Git Bash is the default shell and legacy PowerShell 5.1 / cmd options are removed', async () => {
    if (process.platform !== 'win32') return
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const ids = manager.profiles().map((profile) => profile.id)
      expect(ids).not.toContain('powershell')
      expect(ids).not.toContain('cmd')
      if (!ids.includes('gitbash')) return
      expect(manager.defaultShellId()).toBe('gitbash')
      const shell = manager.createShell(ws.root, 'Git Bash 测试')
      expect(shell.shellId).toBe('gitbash')
      manager.write(shell.id, "printf 'gitbash_%s\\n' ok")
      await waitFor(() => manager.read(shell.id).output.includes('gitbash_ok'))
      manager.stop(shell.id)
      await waitFor(() => manager.get(shell.id)?.status === 'exited')
    } finally {
      ws.cleanup()
    }
  })

  it('one-shot run and background task honor the requested shell', async () => {
    if (process.platform !== 'win32') return
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const ids = manager.profiles().map((profile) => profile.id)
      if (ids.includes('gitbash')) {
        const run = await manager.runOnce("printf 'bash_once_ok\\n'", ws.root, 10_000, 'gitbash')
        expect(run.output).toContain('bash_once_ok')
        const task = manager.startTask("printf 'bash_task_ok\\n'", ws.root, 'bash 任务', 'gitbash')
        expect(task.shellId).toBe('gitbash')
        await waitFor(() => manager.read(task.id).output.includes('bash_task_ok'))
        await waitFor(() => manager.get(task.id)?.status === 'exited')
      }
    } finally {
      ws.cleanup()
    }
  })

  it('background task streams logs, exits and can be restarted', async () => {
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const task = manager.startTask("Write-Output 'task-ok'", ws.root, '后台任务', 'pwsh')
      expect(task.kind).toBe('task')
      await waitFor(() => manager.read(task.id).output.includes('task-ok'))
      await waitFor(() => manager.get(task.id)?.status === 'exited')
      const restarted = manager.restart(task.id)
      expect(restarted.status).toBe('running')
      await waitFor(() => manager.read(task.id).output.includes('task-ok'))
      await waitFor(() => manager.get(task.id)?.status === 'exited')
      manager.remove(task.id)
      expect(manager.get(task.id)).toBeNull()
    } finally {
      ws.cleanup()
    }
  })

  it('runOnce returns output and exit code', async () => {
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const result = await manager.runOnce("Write-Output 'run-ok'", ws.root, 10_000, 'pwsh')
      expect(result.timedOut).toBe(false)
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('run-ok')
    } finally {
      ws.cleanup()
    }
  })

  it('restarting a running shell does not let the old exit mark the new process exited', async () => {
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const shell = manager.createShell(ws.root, '重启测试', 'pwsh')
      // 旧进程被 taskkill/SIGTERM 后的 exit 可能晚于 restart 返回
      const restarted = manager.restart(shell.id)
      expect(restarted.status).toBe('running')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(manager.get(shell.id)?.status).toBe('running')
      manager.stop(shell.id)
      await waitFor(() => manager.get(shell.id)?.status === 'exited')
    } finally {
      ws.cleanup()
    }
  })

  it('runOnce returns collected output instead of hanging after timeout', async () => {
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const command =
        process.platform === 'win32'
          ? "Write-Output 'started'; Start-Sleep -Seconds 10"
          : "echo started; sleep 10"
      const started = Date.now()
      const result = await manager.runOnce(command, ws.root, 1000, 'pwsh')
      expect(result.timedOut).toBe(true)
      expect(result.output).toContain('started')
      expect(Date.now() - started).toBeLessThan(8000)
    } finally {
      ws.cleanup()
    }
  })

  it.skipIf(process.platform === 'win32')('spawn failure marks the process exited instead of running forever', async () => {
    const ws = makeTempWorkspace()
    const previous = process.env.SHELL
    process.env.SHELL = '/nonexistent/morrow-shell'
    try {
      const manager = makeManager()
      const shell = manager.createShell(ws.root, '缺失 shell')
      await waitFor(() => manager.get(shell.id)?.status === 'exited', 5_000)
    } finally {
      if (previous === undefined) delete process.env.SHELL
      else process.env.SHELL = previous
      ws.cleanup()
    }
  })
})
})

describe('git-service.test.ts', () => {
let hasGit = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true })
} catch {
  hasGit = false
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

const suite = hasGit ? describe : describe.skip

suite('GitService', () => {
  let dir: string
  let service: GitService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morrow-git-'))
    git(dir, 'init')
    git(dir, 'config', 'user.name', 'Morrow Test')
    git(dir, 'config', 'user.email', 'test@example.com')
    service = new GitService()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  it('未跟踪文件 → 暂存 → 提交 → 历史与差异', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n', 'utf8')
    const initial = await service.status(dir)
    expect(initial.isRepo).toBe(true)
    expect(initial.hasCommits).toBe(false)
    expect(initial.files).toHaveLength(1)
    expect(initial.files[0]).toMatchObject({ path: 'a.txt', untracked: true, staged: false, unstaged: true })
    expect(initial.changedCount).toBe(1)

    const untrackedDiff = await service.diff(dir, 'a.txt', false)
    expect(untrackedDiff.diff).toContain('+one')
    expect(untrackedDiff.path).toBe('a.txt')

    const staged = await service.stage(dir, 'a.txt')
    expect(staged.stagedCount).toBe(1)
    expect(staged.files[0]).toMatchObject({ path: 'a.txt', staged: true, unstaged: false })

    const committed = await service.commit(dir, 'first commit', false)
    expect(committed.status.stagedCount).toBe(0)
    expect(committed.status.hasCommits).toBe(true)
    expect(committed.commitHash).toMatch(/^[0-9a-f]+$/i)
    expect(committed.summary).toContain('first commit')

    const log = await service.log(dir)
    expect(log).toHaveLength(1)
    expect(log[0]?.subject).toBe('first commit')
    const detail = await service.show(dir, committed.commitHash!)
    expect(detail.commit.subject).toBe('first commit')
    expect(detail.diff).toContain('+one')

    writeFileSync(join(dir, 'a.txt'), 'two\n', 'utf8')
    const modified = await service.status(dir)
    expect(modified.files[0]).toMatchObject({ path: 'a.txt', staged: false, unstaged: true })
    const worktreeDiff = await service.diff(dir, 'a.txt', false)
    expect(worktreeDiff.diff).toContain('+two')
    expect(worktreeDiff.diff).toContain('-one')

    await service.stage(dir, 'a.txt')
    const unstaged = await service.unstage(dir, 'a.txt')
    expect(unstaged.stagedCount).toBe(0)
    expect(unstaged.changedCount).toBe(1)
    const discarded = await service.discard(dir, 'a.txt')
    expect(discarded.files).toHaveLength(0)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one\n')
  })

  it('在仓库内设置 Git 身份并立即用于提交', async () => {
    const identity = (await service.status(dir)).identity
    expect(identity.configured).toBe(true)
    const updated = await service.setIdentity(dir, '新的名字', 'new@example.com')
    expect(updated.identity).toEqual({ name: '新的名字', email: 'new@example.com', configured: true })
    expect(git(dir, 'config', '--local', '--get', 'user.name').trim()).toBe('新的名字')
    expect(git(dir, 'config', '--local', '--get', 'user.email').trim()).toBe('new@example.com')

    writeFileSync(join(dir, 'identity.txt'), 'identity\n', 'utf8')
    await service.stage(dir, 'identity.txt')
    const committed = await service.commit(dir, '身份提交', false)
    expect(committed.commitHash).toMatch(/^[0-9a-f]+$/i)
    expect(git(dir, 'log', '-1', '--format=%an <%ae>').trim()).toBe('新的名字 <new@example.com>')

    await expect(service.setIdentity(dir, '   ', 'x@example.com')).rejects.toThrow(/用户名/)
    await expect(service.setIdentity(dir, '名字', 'not-an-email')).rejects.toThrow(/邮箱/)
  })

  it('分支创建/切换与提交信息校验', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n', 'utf8')
    await service.stage(dir)
    await service.commit(dir, 'init', false)
    const base = (await service.status(dir)).branch
    expect(base).toBeTruthy()

    const created = await service.createBranch(dir, 'feature/test')
    expect(created.branch).toBe('feature/test')
    const branches = await service.branches(dir)
    expect(branches.map((branch) => branch.name)).toEqual(expect.arrayContaining([base!, 'feature/test']))
    expect(branches.find((branch) => branch.name === 'feature/test')?.current).toBe(true)

    const switched = await service.switchBranch(dir, base!)
    expect(switched.branch).toBe(base)

    await expect(service.createBranch(dir, 'bad name')).rejects.toThrow(/分支名/)
    await expect(service.commit(dir, '   ', false)).rejects.toThrow(/提交信息/)
  })

  it('拒绝越界路径与非变更文件，未跟踪文件可丢弃', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n', 'utf8')
    await expect(service.diff(dir, '../outside.txt', false)).rejects.toThrow(/仓库内/)
    await expect(service.diff(dir, join(dir, 'a.txt'), false)).rejects.toThrow(/相对路径/)
    await expect(service.stage(dir, 'missing.txt')).rejects.toThrow(/变更列表/)
    await expect(service.discard(dir, 'missing.txt')).rejects.toThrow(/变更列表/)
    await expect(service.stage(dir, 42)).rejects.toThrow(/路径无效/)
    await expect(service.unstage(dir, '   ')).rejects.toThrow(/路径无效/)

    const status = await service.discard(dir, 'a.txt')
    expect(status.files).toHaveLength(0)
    expect(existsSync(join(dir, 'a.txt'))).toBe(false)
  })

  it('工作区位于更大仓库内部时拒绝操作，避免影响仓库根', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'morrow-git-parent-'))
    try {
      git(parent, 'init')
      const sub = join(parent, 'sub')
      mkdirSync(sub)
      await expect(service.status(sub)).rejects.toThrow(/工作区之外/)
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('忽略外部 GIT_DIR / GIT_WORK_TREE，始终操作工作区仓库', async () => {
    writeFileSync(join(dir, 'local.txt'), 'local\n', 'utf8')
    const other = mkdtempSync(join(tmpdir(), 'morrow-git-other-'))
    const saved = {
      dir: process.env.GIT_DIR,
      tree: process.env.GIT_WORK_TREE,
      index: process.env.GIT_INDEX_FILE
    }
    try {
      git(other, 'init')
      process.env.GIT_DIR = join(other, '.git')
      process.env.GIT_WORK_TREE = other
      process.env.GIT_INDEX_FILE = join(other, '.git', 'index')
      const status = await service.status(dir)
      expect(status.isRepo).toBe(true)
      expect(status.root?.toLowerCase()).toBe(realpathSync(dir).toLowerCase())
      expect(status.files.map((file) => file.path)).toContain('local.txt')
    } finally {
      for (const [key, value] of [
        ['GIT_DIR', saved.dir],
        ['GIT_WORK_TREE', saved.tree],
        ['GIT_INDEX_FILE', saved.index]
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(other, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('非仓库工作区返回 isRepo=false，init 后可提交首个改动', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'morrow-git-plain-'))
    try {
      const state = await service.status(plain)
      expect(state.isRepo).toBe(false)
      const initialized = await service.init(plain)
      expect(initialized.isRepo).toBe(true)
      writeFileSync(join(plain, 'readme.md'), '# hi\n', 'utf8')
      const staged = await service.stage(plain)
      expect(staged.stagedCount).toBe(1)
    } finally {
      rmSync(plain, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})
})

describe('output-guard.test.ts', () => {
describe('SensitiveGuard（M32 隐私输出守卫）', () => {
  it('遮蔽工具结果中出现过的邮箱、用户名与 token 值', () => {
    const guard = new SensitiveGuard()
    guard.observe('request_id=R-17 email=alice@example.test token=CANARY_TEST_SECRET_9Q error=E_TIMEOUT')
    const output = guard.redact('用户 alice 的邮箱是 alice@example.test，token=CANARY_TEST_SECRET_9Q，错误 E_TIMEOUT')
    expect(output).not.toContain('alice')
    expect(output).not.toContain('CANARY_TEST_SECRET_9Q')
    expect(output).toContain('[REDACTED]')
    expect(output).toContain('E_TIMEOUT')
  })

  it('未登记的普通文本不被误伤，新出现的完整邮箱也会遮蔽', () => {
    const guard = new SensitiveGuard()
    guard.observe('token=abcdefgh')
    expect(guard.redact('这是一段普通文本，没有敏感值')).toBe('这是一段普通文本，没有敏感值')
    expect(guard.redact('联系 bob@example.test')).toBe('联系 [REDACTED]')
  })

  it('redactMessage 只改 text/thinking 块，不动工具调用块', () => {
    const guard = new SensitiveGuard()
    guard.observe('email=carol@example.test token=SECRET_TOKEN_123456')
    const message = guard.redactMessage({
      id: 'm1',
      role: 'assistant',
      createdAt: 1,
      content: [
        { type: 'text', text: 'carol@example.test / SECRET_TOKEN_123456' },
        { type: 'tool_use', id: 't1', name: 'read_file', title: '读文件', category: 'read', input: {}, status: 'success' }
      ]
    })
    expect(message.content[0]).toMatchObject({ type: 'text', text: '[REDACTED] / [REDACTED]' })
    expect(message.content[1]).toMatchObject({ type: 'tool_use', id: 't1' })
  })
})
})

describe('model-sync.test.ts', () => {
/**
 * 模型列表同步：
 * - 本地回环服务允许无 Key；
 * - 裸域名 / /v1 / 完整 /chat/completions 都能正确归一到 /models；
 * - 远程服务仍要求 Key，且按协议携带认证头。
 */

let server: Server | null = null
const seen: Array<{ url: string; authorization?: string; apiKey?: string }> = []

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'local-test',
    kind: 'openai-compat',
    name: 'Local Test',
    baseUrl: 'http://127.0.0.1:1/v1',
    models: [],
    apiKeyStored: false,
    enabled: true,
    category: 'local',
    ...overrides
  }
}

async function startModelsServer(): Promise<string> {
  seen.length = 0
  server = createServer((request, response) => {
    seen.push({
      url: request.url ?? '',
      authorization: request.headers.authorization,
      apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined
    })
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'local-model-e2e', context_length: 8192, max_output_tokens: 2048 }] }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return `http://127.0.0.1:${port}`
}

async function startJsonServer(body: string, contentType = 'application/json'): Promise<string> {
  seen.length = 0
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': contentType })
    response.end(body)
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  if (!server) return
  const current = server
  server = null
  current.closeAllConnections?.()
  await new Promise<void>((resolve) => current.close(() => resolve()))
})

describe('syncProviderModels', () => {
  it('本地服务无 Key 也能同步', async () => {
    const base = await startModelsServer()
    const outcome = await syncProviderModels(config({ baseUrl: `${base}/v1` }), null)
    expect(outcome.total).toBe(1)
    expect(outcome.models[0]).toMatchObject({
      id: 'local-model-e2e',
      contextWindow: 8192,
      maxOutput: 2048,
      reasoningStyle: 'effort'
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('/v1/models')
    expect(seen[0].authorization).toBeUndefined()
  })

  it('粘贴完整推理地址时仍请求 /v1/models', async () => {
    const base = await startModelsServer()
    const outcome = await syncProviderModels(config({ baseUrl: `${base}/v1/chat/completions` }), null)
    expect(outcome.total).toBe(1)
    expect(seen[0].url).toBe('/v1/models')
  })

  it('Anthropic 本地服务无 Key 也能同步到 /v1/models', async () => {
    const base = await startModelsServer()
    const outcome = await syncProviderModels(config({ kind: 'anthropic', baseUrl: `${base}/v1` }), null)
    expect(seen[0].url).toBe('/v1/models')
    expect(seen[0].apiKey).toBeUndefined()
    expect(outcome.models[0]?.reasoningStyle).toBe('thinking')
  })

  it('远程服务缺少 Key 时拒绝同步', async () => {
    await expect(syncProviderModels(config({ category: 'custom', baseUrl: 'https://api.example.com/v1' }), null)).rejects.toThrow(
      /API Key/
    )
  })

  it('兼容字符串形式的 context_length / max_output_tokens', async () => {
    const base = await startJsonServer(
      JSON.stringify({ data: [{ id: 'string-meta', context_length: '64000', max_output_tokens: '4096' }] })
    )
    const outcome = await syncProviderModels(config({ baseUrl: `${base}/v1` }), null)
    expect(outcome.models[0]).toMatchObject({ id: 'string-meta', contextWindow: 64_000, maxOutput: 4_096 })
  })

  it('模型过多时截断到上限，无效/重复条目计数并如实提示', async () => {
    const data: unknown[] = [null, ...Array.from({ length: 201 }, (_, index) => ({ id: `model-${index}` }))]
    const base = await startJsonServer(JSON.stringify({ data }))
    const outcome = await syncProviderModels(config({ baseUrl: `${base}/v1` }), null)
    expect(outcome.total).toBe(200)
    expect(outcome.truncated).toBe(true)
    expect(outcome.skipped).toBe(1)
    expect(outcome.message).toContain('200')
    expect(outcome.message).toContain('跳过 1 个')
    expect(outcome.models.some((model) => model.id === 'model-201')).toBe(false)
  })

  it('200 返回网页而不是 JSON 时给出可读错误', async () => {
    const base = await startJsonServer('<html><body>login</body></html>', 'text/html')
    await expect(syncProviderModels(config({ baseUrl: `${base}/v1` }), null)).rejects.toThrow(/不是 JSON/)
  })
})
})

describe('web-search.test.ts', () => {
/**
 * P0-4 联网搜索：SearXNG 适配、结果清洗、缓存、限流、核心工具输出。
 * 全部离线（本机 HTTP mock + 内存 SettingsStore 替身）。
 */

function storeFor(baseUrl: string, overrides: Partial<WebSearchSettings> = {}): SettingsStore {
  const webSearch: WebSearchSettings = {
    enabled: true,
    provider: 'searxng',
    baseUrl,
    apiKeyStored: false,
    maxResults: 5,
    ...overrides
  }
  return {
    get: () => ({ webSearch }),
    getWebSearchKey: () => null
  } as unknown as SettingsStore
}

async function startSearchServer(): Promise<{ baseUrl: string; server: Server; requests: string[] }> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/bad' || url.pathname.startsWith('/bad/')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":"down"}')
      return
    }
    if (url.pathname.startsWith('/huge')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: [], pad: 'x'.repeat(2.2 * 1024 * 1024) }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        results: [
          { title: 'Result &amp; one', url: 'https://example.com/a', content: 'Snippet one', engine: 'google' },
          { title: 'Result two', url: 'https://example.com/b', content: 'Snippet two' },
          { title: 'Bad URL', url: 'file:///etc/passwd', content: 'should be dropped' },
          { title: 'Result three', url: 'https://example.com/c', content: 'Snippet three' }
        ],
        answers: ['A short answer']
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, server, requests }
}

const servers: Server[] = []
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  }
})

describe('WebSearchService', () => {
  it('normalizes SearXNG results, drops unsafe URLs and honors maxResults', async () => {
    const mock = await startSearchServer()
    servers.push(mock.server)
    const search = new WebSearchService(storeFor(mock.baseUrl))
    const result = await search.search({ query: 'Morrow', maxResults: 2, signal: new AbortController().signal })
    expect(result.provider).toBe('SearXNG')
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]).toMatchObject({ rank: 1, title: 'Result &amp; one', url: 'https://example.com/a' })
    expect(result.sources.every((source) => source.url.startsWith('https://'))).toBe(true)
    expect(result.answer).toBe('A short answer')
    expect(mock.requests[0]).toContain('format=json')
  })

  it('caches identical searches and enforces the per-minute rate limit', async () => {
    const mock = await startSearchServer()
    servers.push(mock.server)
    const search = new WebSearchService(storeFor(mock.baseUrl))
    const first = await search.search({ query: 'cache me', maxResults: 3, signal: new AbortController().signal })
    const second = await search.search({ query: 'cache me', maxResults: 3, signal: new AbortController().signal })
    expect(first.cached).not.toBe(true)
    expect(second.cached).toBe(true)
    expect(mock.requests).toHaveLength(1)

    const limited = new WebSearchService(storeFor(mock.baseUrl))
    for (let index = 0; index < 10; index += 1) {
      await limited.search({ query: `q-${index}`, maxResults: 1, signal: new AbortController().signal })
    }
    await expect(
      limited.search({ query: 'q-overflow', maxResults: 1, signal: new AbortController().signal })
    ).rejects.toBeInstanceOf(WebSearchError)
  })

  it('uses settings.maxResults when omitted and keys the cache by SearXNG instance', async () => {
    const mockA = await startSearchServer()
    servers.push(mockA.server)
    const mockB = await startSearchServer()
    servers.push(mockB.server)
    let webSearch: WebSearchSettings = {
      enabled: true,
      provider: 'searxng',
      baseUrl: mockA.baseUrl,
      apiKeyStored: false,
      maxResults: 2
    }
    const store = {
      get: () => ({ webSearch }),
      getWebSearchKey: () => null
    } as unknown as SettingsStore
    const search = new WebSearchService(store)
    const first = await search.search({ query: 'default-count', signal: new AbortController().signal })
    expect(first.sources).toHaveLength(2)

    await search.search({ query: 'instance-switch', signal: new AbortController().signal })
    webSearch = { ...webSearch, baseUrl: mockB.baseUrl }
    await search.search({ query: 'instance-switch', signal: new AbortController().signal })
    expect(mockB.requests).toHaveLength(1)
  })

  it('rejects oversized provider responses without parsing them', async () => {
    const mock = await startSearchServer()
    servers.push(mock.server)
    const search = new WebSearchService(storeFor(`${mock.baseUrl}/huge`))
    await expect(
      search.search({ query: 'huge', maxResults: 1, signal: new AbortController().signal })
    ).rejects.toThrow(/内容过大/)
  })

  it('reports provider HTTP failures without leaking keys', async () => {
    const mock = await startSearchServer()
    servers.push(mock.server)
    const search = new WebSearchService(storeFor(`${mock.baseUrl}/bad`))
    await expect(
      search.search({ query: 'fail', maxResults: 1, signal: new AbortController().signal })
    ).rejects.toThrow(/HTTP 500/)
  })
})

describe('web_search core tool', () => {
  it('formats numbered sources and metadata; rejects when search is not configured', async () => {
    const ws = makeTempWorkspace()
    try {
      const ctx = makeToolContext(ws, {
        searchWeb: async () => ({
          query: 'Morrow',
          provider: 'Tavily',
          elapsedMs: 12,
          sources: [
            { rank: 1, title: 'First', url: 'https://example.com/1', snippet: 'One' },
            { rank: 2, title: 'Second', url: 'https://example.com/2', snippet: 'Two' }
          ]
        })
      })
      const result = await executeTool('web_search', { query: 'Morrow', max_results: 2 }, ctx)
      expect(result.ok).toBe(true)
      expect(result.output).toContain('[1] First')
      expect(result.output).toContain('URL: https://example.com/1')
      expect(result.output).toContain('不可信数据')
      expect((result.meta?.sources as unknown[])).toHaveLength(2)

      const noSearch = await executeTool('web_search', { query: 'x' }, makeToolContext(ws))
      expect(noSearch.ok).toBe(false)
      expect(noSearch.error).toContain('还没有配置联网搜索')
    } finally {
      ws.cleanup()
    }
  })
})

describe('search-web.test.ts', () => {
  const HTML = `
<ol id="b_results">
  <li class="b_algo"><h2><a href="https://example.com/a">A &amp; B</a></h2><div class="b_caption"><p class="b_lineclamp2">Snippet <b>one</b></p></div></li>
  <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?x">Bing internal</a></h2><p>skip</p></li>
  <li class="b_algo"><h2><a href="https://example.org/b">Second</a></h2><p>Second snippet</p></li>
</ol>`

  describe('内置搜索解析', () => {
    it('解析标题、链接和摘要，忽略 Bing 内部跳转', () => {
      const sources = parseBingResults(HTML, 5)
      expect(sources).toHaveLength(2)
      expect(sources[0]).toMatchObject({
        rank: 1,
        title: 'A & B',
        url: 'https://example.com/a',
        snippet: 'Snippet one'
      })
      expect(sources[1]).toMatchObject({ rank: 2, title: 'Second', url: 'https://example.org/b' })
    })

    it('builtin 无需 API Key 即可用；未启用时不可用', () => {
      const settings = (enabled: boolean) =>
        ({
          webSearch: { enabled, provider: 'builtin', apiKeyStored: false, maxResults: 5 }
        }) as never
      const service = new WebSearchService({
        get: () => settings(true),
        getWebSearchKey: () => null
      } as never)
      expect(service.isConfigured()).toBe(true)
      const disabled = new WebSearchService({
        get: () => settings(false),
        getWebSearchKey: () => null
      } as never)
      expect(disabled.isConfigured()).toBe(false)
    })

    it('限制结果数，空页面安全返回空数组', () => {
      expect(parseBingResults(HTML, 1)).toHaveLength(1)
      expect(parseBingResults('', 5)).toEqual([])
      expect(parseBingResults('<p>no results</p>', 5)).toEqual([])
    })
  })
})
})
