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
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolCategory } from '../../../src/shared/types'
import type { BrowserBridge, BrowserState } from '../../../src/core/browser-bridge'
import {
  BROWSER_LIMITS,
  BROWSER_PARTITION,
  BROWSER_WEB_PREFERENCES,
  checkBrowserUrl,
  isBrowserNavigationAllowed,
  isLoopbackHost,
  normalizeBrowserAddress,
  sanitizeBrowserBounds,
  setBrowserBridge,
  validateBrowserTarget
} from '../../../src/core/browser-bridge'
import { BROWSER_TOOL_NAMES, browserTools } from '../../../src/core/tools/browser-tools'
import {
  EXTERNAL_ACTION_TOOLS,
  evaluatePermission,
  type PermissionPolicyContext,
  type PermissionTarget
} from '../../../src/core/permissions'
import { makeToolContext } from '../core/helpers/tool-context'
import { makeTempWorkspace } from '../core/helpers/workspace'

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
    automationActive: false
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

  it('导出 7 个工具名，全部为 exec + high 风险（只读模式由权限层直接拒绝）', () => {
    expect(BROWSER_TOOL_NAMES).toHaveLength(7)
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

  it('只读上下文（子代理）一律拒绝浏览器操作', async () => {
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

  it('ask：全部浏览器工具返回 ask', () => {
    for (const name of BROWSER_TOOL_NAMES) {
      const gate = evaluatePermission(permissionTarget(name), policy('ask'))
      expect(gate.action, name).toBe('ask')
    }
  })

  it('auto：接入 EXTERNAL_ACTION_TOOLS 后也应 ask（Lead 集成接线点，测试内模拟 wiring）', () => {
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
        expect(gate.action, name).toBe('ask')
      }
    } finally {
      for (const name of added) external.delete(name)
    }
  })
})
