/**
 * R8 外部工具 · web_fetch（离线验证，不依赖公网）：
 * - SSRF 防护：协议白名单、本地/内网 IPv4/IPv6、DNS 解析后再校验、重定向逐跳校验；
 * - 抓取行为：超时、大小上限、重定向次数、404/二进制错误、HTML→可读文本；
 * - 工具层：schema 只允许 GET 读取（无 method/headers/body）、成功/失败文案、meta。
 *
 * 用本机 127.0.0.1 上的 fixture HTTP server 验证真实网络路径；
 * 生产默认禁止内网，测试通过 allowPrivateNetwork 显式放行（仅 createWebFetchTool 的测试注入）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '../../../src/core/types'
import {
  createWebFetchTool,
  fetchWebPage,
  htmlToReadable,
  isBlockedAddress,
  validatePublicUrl,
  WebFetchError,
  WEB_FETCH_LIMITS
} from '../../../src/core/tools/web-tools'

/* ── 本地 HTTP fixture ─────────────────────────────────────────── */

interface FixtureServer {
  url: string
  requests: Array<{ method: string; url: string; headers: IncomingMessage['headers'] }>
  close: () => Promise<void>
}

const servers: FixtureServer[] = []

async function startFixture(): Promise<FixtureServer> {
  const sockets = new Set<Socket>()
  const requests: FixtureServer['requests'] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
    const path = (req.url ?? '/').split('?')[0]
    switch (path) {
      case '/ok': {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          '<!doctype html><html><head><title>Aurora 价格公告</title>' +
            '<meta name="description" content="官方定价页面">' +
            '<style>.x{color:red}</style><script>alert("should-not-appear")</script></head>' +
            '<body><nav>导航链接</nav><main><h1>Basic 方案</h1>' +
            '<p>2026-03-01 起：USD&nbsp;25 / 月 &amp; 含税。</p>' +
            '<ul><li>第一项</li><li>第二项</li></ul></main>' +
            '<footer>页脚</footer></body></html>'
        )
        return
      }
      case '/plain': {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('纯文本内容 line-1\nline-2')
        return
      }
      case '/go': {
        res.writeHead(302, { Location: '/ok' })
        res.end()
        return
      }
      case '/loop': {
        res.writeHead(302, { Location: '/loop' })
        res.end()
        return
      }
      case '/to-file': {
        res.writeHead(302, { Location: 'file:///C:/Windows/win.ini' })
        res.end()
        return
      }
      case '/big': {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.write('B'.repeat(WEB_FETCH_LIMITS.maxBytes + 32 * 1024))
        res.end()
        return
      }
      case '/slow': {
        // 故意不响应：验证客户端超时后主动断开
        return
      }
      case '/binary': {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
        return
      }
      case '/missing': {
        res.writeHead(404, { 'Content-Type': 'text/html' })
        res.end('<h1>not found</h1>')
        return
      }
      case '/boom': {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('server error')
        return
      }
      default: {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('no fixture')
      }
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server 未监听端口')
  const fixture: FixtureServer = {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
  servers.push(fixture)
  return fixture
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    if (server) await server.close()
  }
})

/* ── ToolContext stub ─────────────────────────────────────────── */

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'session_web',
    runId: 'run_web',
    messageId: 'msg_web',
    toolUseId: 'tool_web',
    workspace: null,
    permissionMode: 'ask',
    snapshotDir: '',
    signal: new AbortController().signal,
    depth: 0,
    readOnly: false,
    escapeApproved: false,
    demo: false,
    goal: null,
    emit: () => undefined,
    updateGoal: () => null,
    getTodos: () => [],
    setTodos: () => undefined,
    getArtifacts: () => [],
    addArtifact: () => undefined,
    askUser: async () => ({ value: 'A', label: 'A' }),
    progress: () => undefined,
    runSubagent: async () => ({ status: 'completed', summary: '', steps: 0, usage: { inputTokens: 0, outputTokens: 0 } }),
    ...overrides
  }
}

/* ── HTML → 可读文本 ──────────────────────────────────────────── */

describe('htmlToReadable', () => {
  it('提取标题、meta 描述与正文，去掉 script/style/nav', () => {
    const html =
      '<!doctype html><html><head><title>公告：价格调整</title>' +
      '<meta name="description" content="官方公告"><script>var secret=1</script>' +
      '<style>body{color:#000}</style></head><body><nav>菜单</nav>' +
      '<main><h2>新价格</h2><p>USD 25 每月</p></main><footer>底部</footer></body></html>'
    const readable = htmlToReadable(html)
    expect(readable.title).toBe('公告：价格调整')
    expect(readable.description).toBe('官方公告')
    expect(readable.text).toContain('新价格')
    expect(readable.text).toContain('USD 25 每月')
    expect(readable.text).not.toContain('secret')
    expect(readable.text).not.toContain('color:#000')
    expect(readable.text).not.toContain('菜单')
    expect(readable.text).not.toContain('底部')
  })

  it('解码 HTML 实体、保留列表与换行', () => {
    const readable = htmlToReadable('<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;&nbsp;f</p><ul><li>x</li><li>y</li></ul>')
    expect(readable.text).toContain('a & b <c> "d" \'e\' f')
    expect(readable.text).toContain('- x')
    expect(readable.text).toContain('- y')
  })

  it('没有 main/article 时回退到 body', () => {
    const readable = htmlToReadable('<html><body><div>第一段</div><div>第二段</div></body></html>')
    expect(readable.text).toContain('第一段')
    expect(readable.text).toContain('第二段')
  })

  it('纯文本内容原样保留（不做 HTML 清洗）', () => {
    const readable = htmlToReadable('第一行\n第二行')
    expect(readable.text).toBe('第一行\n第二行')
    expect(readable.title).toBe('')
  })
})

/* ── SSRF：地址判断 ───────────────────────────────────────────── */

describe('isBlockedAddress / validatePublicUrl 的 SSRF 防护', () => {
  it('拦截内网/本地/保留 IPv4 地址', () => {
    const blocked = [
      '127.0.0.1',
      '127.255.255.254',
      '0.0.0.0',
      '10.0.0.8',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '192.0.2.10',
      '198.18.0.1',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255'
    ]
    for (const address of blocked) {
      expect(isBlockedAddress(address), address).toBe(true)
    }
    // 172.15 / 172.32 在外网段，不能误伤
    expect(isBlockedAddress('172.15.0.1')).toBe(false)
    expect(isBlockedAddress('172.32.0.1')).toBe(false)
    expect(isBlockedAddress('93.184.216.34')).toBe(false)
    expect(isBlockedAddress('8.8.8.8')).toBe(false)
  })

  it('拦截 IPv6 本地/link-local/ULA/multicast 与 IPv4-mapped 内网', () => {
    const blocked = ['::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2001:db8::1']
    for (const address of blocked) {
      expect(isBlockedAddress(address), address).toBe(true)
    }
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false)
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false)
  })

  it('拒绝非 http(s) 协议、带凭据的 URL 与空 URL', async () => {
    for (const raw of ['file:///C:/Windows/win.ini', 'ftp://example.com/a', 'javascript:alert(1)', 'mailto:a@b.c', '']) {
      await expect(validatePublicUrl(raw)).rejects.toMatchObject({ kind: 'invalid-url' })
    }
    await expect(validatePublicUrl('http://user:pass@example.com/')).rejects.toMatchObject({ kind: 'invalid-url' })
  })

  it('拒绝 localhost / .local / 云元数据主机名（不依赖 DNS）', async () => {
    const hosts = ['http://localhost:8080/', 'http://foo.localhost/', 'http://printer.local/', 'http://metadata.google.internal/', 'http://service.internal/']
    for (const raw of hosts) {
      const error = (await validatePublicUrl(raw).catch((err: unknown) => err as WebFetchError)) as WebFetchError
      expect(error, raw).toBeInstanceOf(WebFetchError)
      expect(error.kind, raw).toBe('ssrf-blocked')
    }
  })

  it('DNS 解析到内网地址时拒绝（解析后再校验一次）', async () => {
    const resolveHost = async (): Promise<Array<{ address: string; family: number }>> => [{ address: '10.1.2.3', family: 4 }]
    const error = (await validatePublicUrl('http://totally-public.example/', { resolveHost }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
    expect(error).toBeInstanceOf(WebFetchError)
    expect(error.kind).toBe('ssrf-blocked')
    expect(error.message).toContain('内网')

    const ok = await validatePublicUrl('http://totally-public.example/', {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }]
    })
    expect(ok.hostname).toBe('totally-public.example')
  })

  it('域名解析失败时给出可理解的错误', async () => {
    const error = (await validatePublicUrl('http://does-not-exist.invalid/', {
      resolveHost: async () => {
        throw new Error('ENOTFOUND')
      }
    }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
    expect(error).toBeInstanceOf(WebFetchError)
    expect(error.kind).toBe('dns')
  })
})

/* ── 抓取行为（本地 fixture，真实 HTTP 路径） ─────────────────── */

describe('fetchWebPage（本地 HTTP fixture）', () => {
  it('抓取 HTML：标题/正文清洗、最终 URL、状态码、内容类型与耗时', async () => {
    const fixture = await startFixture()
    const result = await fetchWebPage(`${fixture.url}/ok`, { allowPrivateNetwork: true })
    expect(result.status).toBe(200)
    expect(result.finalUrl).toBe(`${fixture.url}/ok`)
    expect(result.contentType).toContain('text/html')
    expect(result.title).toBe('Aurora 价格公告')
    expect(result.text).toContain('USD 25 / 月')
    expect(result.text).toContain('第一项')
    expect(result.text).not.toContain('should-not-appear')
    expect(result.text).not.toContain('导航链接')
    expect(result.bytesRead).toBeGreaterThan(0)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    // 只发 GET，不带请求体/自定义头
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0].method).toBe('GET')
    expect(fixture.requests[0].headers['user-agent']).toContain('Morrow')
  })

  it('读取 text/plain 内容', async () => {
    const fixture = await startFixture()
    const result = await fetchWebPage(`${fixture.url}/plain`, { allowPrivateNetwork: true })
    expect(result.text).toContain('纯文本内容 line-1')
    expect(result.contentType).toContain('text/plain')
  })

  it('跟随重定向并返回最终 URL 与跳转链', async () => {
    const fixture = await startFixture()
    const result = await fetchWebPage(`${fixture.url}/go`, { allowPrivateNetwork: true })
    expect(result.finalUrl).toBe(`${fixture.url}/ok`)
    expect(result.redirects).toContain(`${fixture.url}/go`)
    expect(result.text).toContain('Basic 方案')
  })

  it('重定向次数超限时报错', async () => {
    const fixture = await startFixture()
    const error = (await fetchWebPage(`${fixture.url}/loop`, { allowPrivateNetwork: true, maxRedirects: 2 }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
    expect(error).toBeInstanceOf(WebFetchError)
    expect(error.kind).toBe('redirect')
    expect(error.message).toContain('重定向')
  })

  it('重定向到 file:// 被拒绝（逐跳校验协议）', async () => {
    const fixture = await startFixture()
    const error = (await fetchWebPage(`${fixture.url}/to-file`, { allowPrivateNetwork: true }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
    expect(error).toBeInstanceOf(WebFetchError)
    expect(error.kind).toBe('invalid-url')
  })

  it('响应超时：主动断开并给出「超时」错误', async () => {
    const fixture = await startFixture()
    const started = Date.now()
    const error = (await fetchWebPage(`${fixture.url}/slow`, { allowPrivateNetwork: true, timeoutMs: 250 }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
    expect(error).toBeInstanceOf(WebFetchError)
    expect(error.kind).toBe('timeout')
    expect(error.message).toContain('超时')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('超大响应按上限截断并标记 truncated', async () => {
    const fixture = await startFixture()
    const result = await fetchWebPage(`${fixture.url}/big`, { allowPrivateNetwork: true, maxBytes: 8 * 1024, maxChars: 4096 })
    expect(result.truncated).toBe(true)
    expect(result.bytesRead).toBeLessThanOrEqual(8 * 1024)
    expect(result.text.length).toBeLessThanOrEqual(4096 + 100)
  })

  it('404 / 500 返回可理解的失败（不把错误页当证据）', async () => {
    const fixture = await startFixture()
    const notFound = (await fetchWebPage(`${fixture.url}/missing`, { allowPrivateNetwork: true }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
    expect(notFound).toBeInstanceOf(WebFetchError)
    expect(notFound.kind).toBe('http-status')
    expect(notFound.message).toContain('404')

    const boom = (await fetchWebPage(`${fixture.url}/boom`, { allowPrivateNetwork: true }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
    expect(boom.kind).toBe('http-status')
    expect(boom.message).toContain('500')
  })

  it('二进制内容（图片/PDF 等）明确拒绝而非乱码', async () => {
    const fixture = await startFixture()
    const error = (await fetchWebPage(`${fixture.url}/binary`, { allowPrivateNetwork: true }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
    expect(error).toBeInstanceOf(WebFetchError)
    expect(error.kind).toBe('binary')
    expect(error.message).toContain('image/png')
  })

  it('生产默认拒绝本机/内网地址（不发请求）', async () => {
    const fixture = await startFixture()
    const error = (await fetchWebPage(`${fixture.url}/ok`, { timeoutMs: 500 }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
    expect(error).toBeInstanceOf(WebFetchError)
    expect(error.kind).toBe('ssrf-blocked')
    expect(fixture.requests).toHaveLength(0)
  })

  it('已中断的 signal 直接返回中断错误', async () => {
    const controller = new AbortController()
    controller.abort()
    const fixture = await startFixture()
    await expect(
      fetchWebPage(`${fixture.url}/ok`, { allowPrivateNetwork: true, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

/* ── 工具层：schema / 成功文案 / 失败文案 ─────────────────────── */

describe('createWebFetchTool', () => {
  it('schema 只暴露 GET 读取参数，没有 method/headers/body（结构上无法 POST）', () => {
    const tool = createWebFetchTool()
    expect(tool.definition.name).toBe('web_fetch')
    expect(tool.definition.category).toBe('exec')
    expect(tool.definition.risk).toBe('medium')
    const parameters = tool.definition.parameters as {
      type: string
      required?: string[]
      properties: Record<string, unknown>
    }
    expect(parameters.type).toBe('object')
    expect(parameters.required).toEqual(['url'])
    expect(Object.keys(parameters.properties).sort()).toEqual(['max_chars', 'url'])
    expect(tool.definition.description).toContain('GET')
    expect(tool.definition.titleFor({ url: 'https://example.com/a' })).toContain('example.com')
  })

  it('SSRF：工具默认拒绝 127.0.0.1（即使本地 server 在跑）', async () => {
    const fixture = await startFixture()
    const tool = createWebFetchTool()
    const result = await tool.execute({ url: `${fixture.url}/ok` }, makeCtx())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('内网')
    expect(result.hint).toBeTruthy()
    expect(fixture.requests).toHaveLength(0)
  })

  it('拒绝 file:// 与带凭据 URL，错误面向新手可理解', async () => {
    const tool = createWebFetchTool()
    for (const url of ['file:///C:/Windows/win.ini', 'http://user:pass@example.com/']) {
      const result = await tool.execute({ url }, makeCtx())
      expect(result.ok).toBe(false)
      expect(result.error).toContain('http')
    }
  })

  it('成功时返回来源 URL、状态、标题与「不可信数据」声明', async () => {
    const fixture = await startFixture()
    const tool = createWebFetchTool({ allowPrivateNetwork: true })
    const result = await tool.execute({ url: `${fixture.url}/ok` }, makeCtx())
    expect(result.ok).toBe(true)
    expect(result.output).toContain('不可信')
    expect(result.output).toContain('Aurora 价格公告')
    expect(result.output).toContain(`${fixture.url}/ok`)
    expect(result.output).toContain('200')
    expect(result.meta).toMatchObject({
      finalUrl: `${fixture.url}/ok`,
      status: 200,
      title: 'Aurora 价格公告'
    })
  })

  it('max_chars 参数生效：正文按请求截断', async () => {
    const fixture = await startFixture()
    const tool = createWebFetchTool({ allowPrivateNetwork: true })
    const result = await tool.execute({ url: `${fixture.url}/big`, max_chars: 500 }, makeCtx())
    expect(result.ok).toBe(true)
    expect(result.output.length).toBeLessThan(2500)
    expect(result.meta?.truncated).toBe(true)
  })

  it('参数缺失/类型错误回灌可自修复的错误', async () => {
    const tool = createWebFetchTool()
    const missing = await tool.execute({}, makeCtx())
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('url')
    const bad = await tool.execute({ url: 'not-a-url' }, makeCtx())
    expect(bad.ok).toBe(false)
  })

  it('DNS 解析注入：解析到内网地址时在连接前拒绝', async () => {
    const tool = createWebFetchTool({
      allowPrivateNetwork: false,
      resolveHost: async () => [{ address: '192.168.1.50', family: 4 }]
    })
    const result = await tool.execute({ url: 'http://looks-public.example/page' }, makeCtx())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('内网')
  })
})
