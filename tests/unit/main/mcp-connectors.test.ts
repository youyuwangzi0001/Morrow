/**
 * R10-G/K2：MCP 连接器（stdio 回归 + Streamable HTTP + 旧版 HTTP/SSE + 管理服务 + feature IPC）。
 *
 * 全部离线：本机 node:http mock（JSON / SSE 响应 / 旧版 SSE）、临时目录、mock Electron safeStorage。
 * 覆盖：initialize → tools/list → tools/call、会话头、超时、取消、SSRF（localhost/内网/协议）、
 * 配置校验、密钥掩码与加密存储、工作区配置哈希信任、CRUD/启停/测试连接、模板「仅示例」、IPC 参数校验。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '../../../src/core/tools/mcp-tools'
import {
  createMcpConnection,
  loadMcpConfig,
  McpError,
  MCP_SECRET_MARKER,
  normalizeMcpServerInput,
  validateMcpServerUrl
} from '../../../src/core/tools/mcp-tools'

/* ── mock Electron（safeStorage 用可控的假加密；app.getPath = 临时目录） ── */

const electronState = vi.hoisted(() => ({ dataDir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => electronState.dataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    }
  },
  ipcMain: { handle: () => undefined }
}))

import {
  deleteConnector,
  getConnector,
  getConnectorPaths,
  getConnectorTemplates,
  installMcpRuntimeEnv,
  listConnectors,
  saveConnector,
  setConnectorEnabled,
  setSecretCodecForTest,
  testConnector,
  trustWorkspaceConfig,
  workspaceTrustStatus
} from '../../../src/main/services/mcp-service'
import { invokeFeatureForTest } from '../../../src/main/feature-ipc'
import { CONNECTOR_CHANNELS } from '../../../src/main/features/connectors'

/* ── 测试环境 ─────────────────────────────────────────────────── */

const tempDirs: string[] = []
const servers: MockServer[] = []
let dataDir = ''

function makeTempDir(prefix = 'morrow-conn-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  dataDir = makeTempDir('morrow-conn-data-')
  electronState.dataDir = dataDir
  installMcpRuntimeEnv(process.env, dataDir)
})

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    if (server) await server.close()
  }
  setSecretCodecForTest(null)
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/* ── 本机 mock MCP server ────────────────────────────────────── */

interface MockRequestRecord {
  method: string
  message: Record<string, unknown> | null
  headers: IncomingMessage['headers']
}

interface MockServer {
  url: string
  requests: MockRequestRecord[]
  close: () => Promise<void>
}

function startNodeServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<MockServer> {
  const sockets = new Set<Socket>()
  const requests: MockRequestRecord[] = []
  const server: Server = createServer((req, res) => {
    handler(req, res)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise<MockServer>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('mock server 未监听')
      const mock: MockServer = {
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          })
      }
      servers.push(mock)
      // 记录请求由具体 mock 自己 push（这里只提供通用 close）
      resolve(mock)
    })
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

const INITIALIZE_RESULT = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  serverInfo: { name: 'morrow-mock-http', version: '1.0.0' }
}

const TOOLS_RESULT = {
  tools: [
    {
      name: 'echo',
      description: '原样返回参数',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    },
    { name: 'slow', description: '慢响应', inputSchema: { type: 'object', properties: {} } },
    { name: 'fail', description: '返回工具错误', inputSchema: { type: 'object', properties: {} } }
  ]
}

async function startHttpMcp(options: { sseResponses?: boolean; unauthorized?: boolean } = {}): Promise<MockServer> {
  const mock = await startNodeServer((req, res) => {
    void readBody(req).then((body) => {
      let message: Record<string, unknown> | null = null
      try {
        message = JSON.parse(body) as Record<string, unknown>
      } catch {
        message = null
      }
      mock.requests.push({ method: typeof message?.method === 'string' ? message.method : '', message, headers: req.headers })
      if (options.unauthorized) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (!message) {
        res.writeHead(400)
        res.end()
        return
      }
      const reply = (result: unknown, headers: Record<string, string> = {}): void => {
        if (res.destroyed) return
        const payload = JSON.stringify({ jsonrpc: '2.0', id: message?.id, result })
        if (options.sseResponses) {
          res.writeHead(200, { 'content-type': 'text/event-stream', ...headers })
          res.write(`event: message\ndata: ${payload}\n\n`)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', ...headers })
        res.end(payload)
      }
      const method = message.method
      if (method === 'initialize') {
        reply(INITIALIZE_RESULT, { 'Mcp-Session-Id': 'sess-test' })
        return
      }
      if (method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      if (method === 'tools/list') {
        reply(TOOLS_RESULT)
        return
      }
      if (method === 'tools/call') {
        const params = (message.params ?? {}) as Record<string, unknown>
        if (params.name === 'slow') {
          setTimeout(() => {
            try {
              reply({ content: [{ type: 'text', text: 'slow-done' }] })
            } catch {
              // 客户端已超时断开
            }
          }, 1500)
          return
        }
        if (params.name === 'fail') {
          reply({ isError: true, content: [{ type: 'text', text: 'invalid_arguments: text 必填' }] })
          return
        }
        reply({ content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] })
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  return mock
}

async function startLegacySse(): Promise<MockServer> {
  const streams = new Set<ServerResponse>()
  const mock = await startNodeServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').startsWith('/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('event: endpoint\ndata: /messages\n\n')
      streams.add(res)
      res.on('close', () => streams.delete(res))
      return
    }
    if (req.method === 'POST' && (req.url ?? '').startsWith('/messages')) {
      void readBody(req).then((body) => {
        let message: Record<string, unknown> | null = null
        try {
          message = JSON.parse(body) as Record<string, unknown>
        } catch {
          message = null
        }
        mock.requests.push({ method: typeof message?.method === 'string' ? message.method : '', message, headers: req.headers })
        res.writeHead(202)
        res.end()
        if (!message) return
        const send = (result: unknown): void => {
          const payload = JSON.stringify({ jsonrpc: '2.0', id: message?.id, result })
          for (const stream of streams) {
            try {
              stream.write(`event: message\ndata: ${payload}\n\n`)
            } catch {
              // 流已关闭
            }
          }
        }
        if (message.method === 'initialize') send(INITIALIZE_RESULT)
        else if (message.method === 'tools/list') send(TOOLS_RESULT)
        else if (message.method === 'tools/call') {
          const params = (message.params ?? {}) as Record<string, unknown>
          send({ content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] })
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  return mock
}

function httpConfig(url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { transport: 'http', url, allowPrivateNetwork: true, timeoutMs: 4000, retries: 0, ...overrides }
}

async function runWithConnection<T>(config: McpServerConfig, run: (client: ReturnType<typeof createMcpConnection>) => Promise<T>): Promise<T> {
  const client = createMcpConnection('mock-http', config)
  try {
    await client.connect()
    return await run(client)
  } finally {
    await client.close()
  }
}

/* ── 配置校验 ─────────────────────────────────────────────────── */

describe('MCP 配置规范化与校验', () => {
  it('stdio 需要 command；http/sse 需要 url；transport 可从字段推断', () => {
    const missing = normalizeMcpServerInput('x', {})
    expect(missing.errors.join('；')).toContain('配置不完整')

    const stdio = normalizeMcpServerInput('local', { command: 'node', args: ['server.mjs'] })
    expect(stdio.errors).toEqual([])
    expect(stdio.config).toMatchObject({ transport: 'stdio', command: 'node', args: ['server.mjs'] })

    const http = normalizeMcpServerInput('remote', { url: 'https://mcp.example.com/mcp' })
    expect(http.errors).toEqual([])
    expect(http.config).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/mcp' })

    const sse = normalizeMcpServerInput('remote-sse', { type: 'sse', url: 'https://mcp.example.com/sse' })
    expect(sse.config).toMatchObject({ transport: 'sse' })
  })

  it('URL 协议白名单：file/javascript/data/ftp 一律拒绝', () => {
    for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'ftp://example.com/a']) {
      const result = normalizeMcpServerInput('bad', { transport: 'http', url })
      expect(result.config, url).toBeUndefined()
      expect(result.errors.join('；'), url).toMatch(/http|https|协议/)
    }
  })

  it('拒绝 URL 内嵌账号密码、非法 server 名、超范围 timeout/retries', () => {
    const userinfo = normalizeMcpServerInput('bad', { transport: 'http', url: 'https://user:pass@example.com/mcp' })
    expect(userinfo.errors.join('；')).toContain('用户名/密码')

    expect(normalizeMcpServerInput('bad name!', { command: 'node' }).errors.length).toBeGreaterThan(0)
    expect(normalizeMcpServerInput('x', { command: 'node', timeoutMs: 10 }).errors.join('；')).toContain('timeoutMs')
    expect(normalizeMcpServerInput('x', { command: 'node', retries: 9 }).errors.join('；')).toContain('retries')
    expect(normalizeMcpServerInput('x', { command: 'node', timeoutMs: 5000, retries: 1 }).config).toMatchObject({
      timeoutMs: 5000,
      retries: 1
    })
  })

  it('env/headers 键名与换行被过滤并给出警告；密钥标记作为普通字符串通过', () => {
    const result = normalizeMcpServerInput('x', {
      command: 'node',
      env: { OK_KEY: `${MCP_SECRET_MARKER}user/x/env/OK_KEY`, 'bad key': 'v', INJECT: 'a\r\nb' }
    })
    expect(result.errors).toEqual([])
    expect(result.config?.env).toMatchObject({ OK_KEY: `${MCP_SECRET_MARKER}user/x/env/OK_KEY` })
    expect(result.config?.env?.INJECT).toBeUndefined()
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})

/* ── URL 安全 / SSRF ─────────────────────────────────────────── */

describe('MCP URL 安全（SSRF）', () => {
  it('默认拒绝 localhost/回环/内网并给出明确提示', async () => {
    const error = (await validateMcpServerUrl('http://127.0.0.1:8787/mcp').catch((err: unknown) => err)) as McpError
    expect(error).toBeInstanceOf(McpError)
    expect(error.kind).toBe('ssrf-blocked')
    expect(error.message).toContain('本机/内网')
    expect(error.hint).toContain('允许访问本机/内网地址')

    for (const url of ['http://localhost:8787/mcp', 'http://10.0.0.8/mcp', 'http://192.168.1.20/mcp', 'http://[::1]:8787/mcp']) {
      const blocked = (await validateMcpServerUrl(url).catch((err: unknown) => err)) as McpError
      expect(blocked, url).toBeInstanceOf(McpError)
      expect(blocked.kind, url).toBe('ssrf-blocked')
    }
  })

  it('DNS 解析到内网地址时拒绝（解析后再校验）', async () => {
    const error = (await validateMcpServerUrl('https://mcp.public.example/mcp', {
      resolveHost: async () => [{ address: '10.1.2.3', family: 4 }]
    }).catch((err: unknown) => err)) as McpError
    expect(error.kind).toBe('ssrf-blocked')

    const ok = await validateMcpServerUrl('https://mcp.public.example/mcp', {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }]
    })
    expect(ok.hostname).toBe('mcp.public.example')
  })

  it('allowPrivateNetwork=true 时允许本机地址（用户显式信任），但协议仍白名单', async () => {
    const url = await validateMcpServerUrl('http://127.0.0.1:8787/mcp', { allowPrivateNetwork: true })
    expect(url.hostname).toBe('127.0.0.1')
    await expect(validateMcpServerUrl('file:///C:/x', { allowPrivateNetwork: true })).rejects.toMatchObject({ kind: 'config' })
    await expect(validateMcpServerUrl('javascript:alert(1)', { allowPrivateNetwork: true })).rejects.toMatchObject({ kind: 'config' })
  })

  it('未开 allowPrivateNetwork 时 HTTP 连接在发请求前就被拒绝', async () => {
    const mock = await startHttpMcp()
    const client = createMcpConnection('mock', httpConfig(`${mock.url}/mcp`, { allowPrivateNetwork: false }))
    try {
      await expect(client.connect()).rejects.toMatchObject({ kind: 'ssrf-blocked' })
      expect(mock.requests).toHaveLength(0)
    } finally {
      await client.close()
    }
  })
})

/* ── Streamable HTTP / SSE 传输 ──────────────────────────────── */

describe('Streamable HTTP 传输', () => {
  it('initialize → notifications/initialized → tools/list → tools/call（JSON 响应）', async () => {
    const mock = await startHttpMcp()
    const config = httpConfig(`${mock.url}/mcp`)
    const result = await runWithConnection(config, async (client) => {
      expect(client.transport).toBe('http')
      const tools = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(['echo', 'slow', 'fail'])
      const call = await client.callTool('echo', { text: 'hello' })
      return { tools, call }
    })
    expect(result.call.isError).toBe(false)
    expect(result.call.text).toContain('hello')
    // 初始化之后的请求携带 Mcp-Session-Id
    const sessionRequest = mock.requests.find((request) => request.method === 'tools/list')
    expect(sessionRequest?.headers['mcp-session-id']).toBe('sess-test')
  })

  it('服务端用 SSE 返回 JSON-RPC 响应（Content-Type: text/event-stream）', async () => {
    const mock = await startHttpMcp({ sseResponses: true })
    const config = httpConfig(`${mock.url}/mcp`)
    const tools = await runWithConnection(config, (client) => client.listTools())
    expect(tools.map((tool) => tool.name)).toContain('echo')
  })

  it('MCP 工具错误（isError）不当作成功；JSON-RPC error 映射为错误', async () => {
    const mock = await startHttpMcp()
    const config = httpConfig(`${mock.url}/mcp`)
    const failure = await runWithConnection(config, (client) => client.callTool('fail', {}))
    expect(failure.isError).toBe(true)
    expect(failure.text).toContain('invalid_arguments')
  })

  it('401 返回可理解的 http-status 错误与鉴权提示', async () => {
    const mock = await startHttpMcp({ unauthorized: true })
    const client = createMcpConnection('mock', httpConfig(`${mock.url}/mcp`))
    try {
      const error = (await client.connect().catch((err: unknown) => err)) as McpError
      expect(error).toBeInstanceOf(McpError)
      expect(error.kind).toBe('http-status')
      expect(error.message).toContain('401')
      expect(error.hint).toContain('请求头')
    } finally {
      await client.close()
    }
  })

  it('服务器不可达时归类为 network 错误', async () => {
    const mock = await startHttpMcp()
    const deadUrl = `${mock.url}/mcp`
    await mock.close()
    servers.splice(servers.indexOf(mock), 1)
    const client = createMcpConnection('mock', httpConfig(deadUrl, { retries: 0 }))
    try {
      const error = (await client.connect().catch((err: unknown) => err)) as McpError
      expect(error).toBeInstanceOf(McpError)
      expect(error.kind).toBe('network')
    } finally {
      await client.close()
    }
  })
})

describe('旧版 HTTP+SSE 传输', () => {
  it('endpoint 事件 → POST → SSE message 响应（initialize/list/call）', async () => {
    const mock = await startLegacySse()
    const config: McpServerConfig = { transport: 'sse', url: `${mock.url}/sse`, allowPrivateNetwork: true, timeoutMs: 4000, retries: 0 }
    const result = await runWithConnection(config, async (client) => {
      expect(client.transport).toBe('sse')
      const tools = await client.listTools()
      const call = await client.callTool('echo', { text: 'legacy' })
      return { tools, call }
    })
    expect(result.tools.map((tool) => tool.name)).toContain('echo')
    expect(result.call.text).toContain('legacy')
  })
})

describe('超时与取消', () => {
  it('工具调用超时 → timeout 错误（不会挂死）', async () => {
    const mock = await startHttpMcp()
    const config = httpConfig(`${mock.url}/mcp`, { timeoutMs: 500 })
    const started = Date.now()
    const error = (await runWithConnection(config, (client) => client.callTool('slow', {})).catch((err: unknown) => err)) as McpError
    expect(error).toBeInstanceOf(McpError)
    expect(error.kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('AbortSignal 取消进行中的请求', async () => {
    const mock = await startHttpMcp()
    const config = httpConfig(`${mock.url}/mcp`, { timeoutMs: 10_000 })
    const controller = new AbortController()
    const client = createMcpConnection('mock', config, { signal: controller.signal })
    try {
      await client.connect()
      const pending = client.callTool('slow', {})
      setTimeout(() => controller.abort(), 100)
      const error = (await pending.catch((err: unknown) => err)) as Error
      expect(error.name).toBe('AbortError')
    } finally {
      await client.close()
    }
  })
})

/* ── stdio 回归 ──────────────────────────────────────────────── */

const MOCK_STDIO_SOURCE = [
  "const readline = require('node:readline')",
  "const fs = require('node:fs')",
  "if (process.env.MOCK_STDIO_PID_FILE) fs.writeFileSync(process.env.MOCK_STDIO_PID_FILE, String(process.pid))",
  'const tools = [{ name: "echo", description: "回声", inputSchema: { type: "object", properties: { text: { type: "string" } } } }]',
  'function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }',
  "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
  '  let message; try { message = JSON.parse(line) } catch { return }',
  '  if (message.method === "initialize") { send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-stdio", version: "1" } } }); return }',
  '  if (message.method === "notifications/initialized") return',
  '  if (message.method === "tools/list") { send({ jsonrpc: "2.0", id: message.id, result: { tools } }); return }',
  '  if (message.method === "tools/call") { send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(message.params.arguments || {}) }] } }); return }',
  '})',
  "process.on('SIGTERM', () => process.exit(0))"
].join('\n')

describe('stdio 回归', () => {
  it('stdio 连接仍可 initialize/list/call（R8 能力不回退）', async () => {
    const dir = makeTempDir()
    const scriptPath = join(dir, 'mock-stdio.cjs')
    writeFileSync(scriptPath, MOCK_STDIO_SOURCE, 'utf8')
    const config: McpServerConfig = {
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      timeoutMs: 5000
    }
    const result = await runWithConnection(config, async (client) => {
      expect(client.transport).toBe('stdio')
      const tools = await client.listTools()
      const call = await client.callTool('echo', { text: 'stdio-ok' })
      return { tools, call }
    })
    expect(result.tools.map((tool) => tool.name)).toEqual(['echo'])
    expect(result.call.text).toContain('stdio-ok')
  })
})

/* ── 管理服务：保存/掩码/加密/测试连接/删除 ─────────────────── */

describe('连接器管理服务（用户级）', () => {
  it('保存 HTTP 连接器：密钥加密存储、渲染层只拿掩码、mcp.json 只存标记', async () => {
    const mock = await startHttpMcp()
    const saved = saveConnector({
      scope: 'user',
      name: 'remote-http',
      transport: 'http',
      url: `${mock.url}/mcp`,
      allowPrivateNetwork: true,
      headers: [{ key: 'X-Api-Key', value: 'header-secret-value' }]
    })
    const configText = readFileSync(saved.configPath, 'utf8')
    expect(configText).not.toContain('header-secret-value')
    expect(configText).toContain(MCP_SECRET_MARKER)

    const secretsText = readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')
    expect(secretsText).not.toContain('header-secret-value')

    expect(saved.connector.headers).toEqual([
      { key: 'X-Api-Key', masked: '••••••••', hasSecret: true, plaintext: false }
    ])
    // HTTP 传输不使用 env（只有 stdio 有 env 语义）
    expect(saved.connector.env).toEqual([])
    expect(JSON.stringify(saved.connector)).not.toContain('header-secret-value')

    // stdio 的 env 同样加密 + 掩码
    const stdioSaved = saveConnector({
      scope: 'user',
      name: 'local-stdio',
      transport: 'stdio',
      command: 'node',
      env: [{ key: 'API_KEY', value: 'super-secret-value' }]
    })
    const stdioText = readFileSync(stdioSaved.configPath, 'utf8')
    expect(stdioText).not.toContain('super-secret-value')
    expect(stdioText).toContain(MCP_SECRET_MARKER)
    expect(stdioSaved.connector.env).toEqual([
      { key: 'API_KEY', masked: '••••••••', hasSecret: true, plaintext: false }
    ])

    const listed = listConnectors('user')
    expect(listed.connectors.map((item) => item.name)).toEqual(['local-stdio', 'remote-http'])
    expect(listed.secretsMode).toBe('encrypted')
  })

  it('测试连接：解密密钥后真实连接 mock server，返回工具列表', async () => {
    const mock = await startHttpMcp()
    saveConnector({
      scope: 'user',
      name: 'remote-http',
      transport: 'http',
      url: `${mock.url}/mcp`,
      allowPrivateNetwork: true,
      headers: [{ key: 'X-Api-Key', value: 'header-secret-value' }]
    })
    const result = await testConnector({ scope: 'user', name: 'remote-http' })
    expect(result.ok).toBe(true)
    expect(result.transport).toBe('http')
    expect(result.tools?.map((tool) => tool.name)).toContain('echo')
    const callRequest = mock.requests.find((request) => request.method === 'tools/list')
    expect(callRequest?.headers['x-api-key']).toBe('header-secret-value')
  })

  it('测试未保存草稿：不写盘；URL 被 SSRF 拒绝时返回 blockedReason', async () => {
    const draftResult = await testConnector({
      scope: 'user',
      draft: { name: 'draft-http', transport: 'http', url: 'http://127.0.0.1:9/mcp' }
    })
    expect(draftResult.ok).toBe(false)
    expect(draftResult.blockedReason).toBe('ssrf-blocked')
    expect(existsSync(join(dataDir, 'mcp.json'))).toBe(false)
  })

  it('启停、改名（密钥迁移）、删除（清理密钥）', async () => {
    const mock = await startHttpMcp()
    saveConnector({
      scope: 'user',
      name: 'rename-me',
      transport: 'http',
      url: `${mock.url}/mcp`,
      allowPrivateNetwork: true,
      headers: [{ key: 'X-Token', value: 'token-value' }]
    })
    const disabled = setConnectorEnabled('user', 'rename-me', false)
    expect(disabled.enabled).toBe(false)
    expect(JSON.parse(readFileSync(join(dataDir, 'mcp.json'), 'utf8')).mcpServers['rename-me'].disabled).toBe(true)

    // 改名：密钥 id 迁移（keep 旧字段），测试连接仍能解析
    const renamed = saveConnector({
      scope: 'user',
      originalName: 'rename-me',
      name: 'renamed',
      transport: 'http',
      url: `${mock.url}/mcp`,
      allowPrivateNetwork: true,
      headers: [{ key: 'X-Token' }]
    })
    expect(renamed.connector.name).toBe('renamed')
    expect(renamed.connector.headers[0]).toMatchObject({ key: 'X-Token', hasSecret: true })
    const result = await testConnector({ scope: 'user', name: 'renamed' })
    expect(result.ok).toBe(true)

    const removed = deleteConnector('user', 'renamed')
    expect(removed.deleted).toBe(true)
    expect(removed.removedSecrets).toBe(1)
    expect(getConnector('user', 'renamed')).toBeNull()
    const secrets = JSON.parse(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8'))
    expect(Object.keys(secrets.entries)).toHaveLength(0)
  })
})

/* ── 工作区级配置 + 哈希信任 ─────────────────────────────────── */

describe('工作区级连接器与信任登记', () => {
  it('保存工作区级配置写入 .morrow/mcp.json 并登记信任；仓库改文件后信任自动失效', async () => {
    const workspace = makeTempDir('morrow-ws-')
    saveConnector({
      scope: 'workspace',
      workspace,
      name: 'ws-http',
      transport: 'http',
      url: 'https://mcp.example.com/mcp'
    })
    const configPath = join(workspace, '.morrow', 'mcp.json')
    expect(existsSync(configPath)).toBe(true)
    expect(workspaceTrustStatus(workspace).trusted).toBe(true)
    expect(existsSync(join(dataDir, 'mcp-trust.json'))).toBe(true)

    // core 侧 loadMcpConfig 依据哈希信任工作区配置
    const loaded = await loadMcpConfig({ workspace, dataDir })
    expect(loaded.source).toBe('workspace')
    expect(loaded.trusted).toBe(true)
    expect(loaded.servers.map((server) => server.name)).toEqual(['ws-http'])

    // 模拟仓库里的配置被改（攻击场景）：哈希不一致 → 不再信任
    writeFileSync(configPath, JSON.stringify({ mcpServers: { evil: { command: 'calc.exe' } } }), 'utf8')
    const tampered = await loadMcpConfig({ workspace, dataDir })
    expect(tampered.trusted).toBe(false)
    expect(workspaceTrustStatus(workspace).trusted).toBe(false)

    // 用户在面板点「信任」后恢复
    trustWorkspaceConfig(workspace)
    expect(workspaceTrustStatus(workspace).trusted).toBe(true)
  })

  it('工作区级操作缺少 workspace 时明确报错', () => {
    expect(() => saveConnector({ scope: 'workspace', name: 'x', transport: 'http', url: 'https://example.com/mcp' })).toThrow(/工作区/)
  })
})

/* ── feature IPC ─────────────────────────────────────────────── */

describe('feature:connectors:* IPC', () => {
  it('list/save/test/templates 走统一 Result 包装', async () => {
    const mock = await startHttpMcp()
    const empty = await invokeFeatureForTest(CONNECTOR_CHANNELS.list, { scope: 'user' })
    expect(empty.ok).toBe(true)
    expect((empty as { data: { connectors: unknown[] } }).data.connectors).toEqual([])

    const saved = await invokeFeatureForTest(CONNECTOR_CHANNELS.save, {
      scope: 'user',
      name: 'ipc-http',
      transport: 'http',
      url: `${mock.url}/mcp`,
      allowPrivateNetwork: true
    })
    expect(saved.ok).toBe(true)

    const testResult = await invokeFeatureForTest(CONNECTOR_CHANNELS.test, { scope: 'user', name: 'ipc-http' })
    expect(testResult.ok).toBe(true)
    expect((testResult as { data: { ok: boolean; tools: unknown[] } }).data.ok).toBe(true)
    expect((testResult as { data: { tools: unknown[] } }).data.tools.length).toBeGreaterThan(0)

    const enabled = await invokeFeatureForTest(CONNECTOR_CHANNELS.setEnabled, {
      scope: 'user',
      name: 'ipc-http',
      enabled: false
    })
    expect(enabled.ok).toBe(true)
  })

  it('非法参数被边界校验拦下（不把任意对象透传给服务层）', async () => {
    const badName = await invokeFeatureForTest(CONNECTOR_CHANNELS.get, { scope: 'user' })
    expect(badName.ok).toBe(false)

    const badTransport = await invokeFeatureForTest(CONNECTOR_CHANNELS.save, {
      scope: 'user',
      name: 'x',
      transport: 'ftp'
    })
    expect(badTransport.ok).toBe(false)

    const missingWorkspace = await invokeFeatureForTest(CONNECTOR_CHANNELS.list, { scope: 'workspace' })
    expect(missingWorkspace.ok).toBe(false)

    const notObject = await invokeFeatureForTest(CONNECTOR_CHANNELS.list, 'not-an-object')
    expect(notObject.ok).toBe(false)
  })

  it('模板全部标记 exampleOnly（不伪造内置服务）；paths/secretStatus 可用', async () => {
    const templates = await invokeFeatureForTest(CONNECTOR_CHANNELS.templates, {})
    expect(templates.ok).toBe(true)
    const list = (templates as { data: Array<{ exampleOnly: boolean; transport: string }> }).data
    expect(list.length).toBeGreaterThanOrEqual(4)
    expect(list.every((item) => item.exampleOnly === true)).toBe(true)

    const paths = getConnectorPaths('/tmp/some-workspace')
    expect(paths.userConfigPath).toContain('mcp.json')
    expect(paths.secretsPath).toContain('mcp-secrets.json')
    expect(paths.workspaceConfigPath).toContain('.morrow')

    const status = await invokeFeatureForTest(CONNECTOR_CHANNELS.secretStatus, {})
    expect(status.ok).toBe(true)
    expect((status as { data: { mode: string } }).data.mode).toBe('encrypted')
  })
})

/* ── 密钥加密回退 ───────────────────────────────────────────── */

describe('密钥存储模式', () => {
  it('safeStorage 不可用时降级为明文回退并明确标记模式', () => {
    setSecretCodecForTest({
      mode: 'plaintext-fallback',
      encrypt: (plaintext: string) => `plain:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
      decrypt: (payload: string) =>
        payload.startsWith('plain:') ? Buffer.from(payload.slice(6), 'base64').toString('utf8') : null
    })
    const saved = saveConnector({
      scope: 'user',
      name: 'fallback',
      command: 'node',
      env: [{ key: 'TOKEN', value: 'fallback-secret' }]
    })
    expect(saved.secretStorage).toBe('plaintext-fallback')
    expect(saved.connector.secretStorage).toBe('plaintext-fallback')
    const secretsText = readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')
    expect(secretsText).not.toContain('fallback-secret')
  })
})
