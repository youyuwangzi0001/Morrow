/**
 * R8 外部工具 · MCP 客户端（stdio / JSON-RPC 2.0，离线验证）：
 * - 配置发现优先级：MORROW_MCP_CONFIG → 数据目录 mcp.json → 工作区 .morrow/mcp.json；
 *   工作区配置默认「只列不启动」（供应链安全），需 MORROW_MCP_TRUST_WORKSPACE=1；
 * - 协议：initialize → notifications/initialized → tools/list → tools/call；
 * - 失败处理：启动失败、未知 server/tool、工具错误、JSON-RPC 错误、协议脏数据、超时、进程退出；
 * - 生命周期：每次调用后进程必须被清理（超时/协议错误也杀进程）；输出有上限；
 * - 工具语义：mcp_list（meta，只读模式可列）、mcp_call（exec，高风险→审批）。
 *
 * 用本机 Node 启动的 mock stdio MCP server 验证真实进程/管道链路，不依赖公网或第三方 MCP 包。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '../../../src/core/types'
import { executeTool } from '../../../src/core/tools/registry'
import { toolCategory, toolRiskFor } from '../../../src/core/tools/registry'
import { createMcpTools, loadMcpConfig, resolveMcpDataDir } from '../../../src/core/tools/mcp-tools'

/* ── mock stdio MCP server 源码（写到临时目录，用本机 node 启动） ── */

const MOCK_SERVER_SOURCE = [
  "const readline = require('node:readline')",
  "const fs = require('node:fs')",
  "const pidFile = process.env.MOCK_MCP_PID_FILE",
  "if (pidFile) { try { fs.writeFileSync(pidFile, String(process.pid)) } catch {} }",
  'const tools = [',
  "  { name: 'echo', description: '原样返回参数', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },",
  "  { name: 'fail', description: '总是返回工具错误', inputSchema: { type: 'object', properties: {} } },",
  "  { name: 'slow', description: '永不返回', inputSchema: { type: 'object', properties: {} } },",
  "  { name: 'crash', description: '进程直接退出', inputSchema: { type: 'object', properties: {} } },",
  "  { name: 'garbage', description: '返回非法 JSON', inputSchema: { type: 'object', properties: {} } },",
  "  { name: 'huge', description: '返回超长文本', inputSchema: { type: 'object', properties: {} } }",
  ']',
  "function send(message) { process.stdout.write(JSON.stringify(message) + '\\n') }",
  "const rl = readline.createInterface({ input: process.stdin })",
  "rl.on('line', (line) => {",
  '  let message',
  '  try { message = JSON.parse(line) } catch { return }',
  "  if (message.method === 'initialize' && message.id !== undefined) {",
  "    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'morrow-mock', version: '1.0.0' } } })",
  '    return',
  '  }',
  "  if (message.method === 'notifications/initialized') return",
  "  if (message.method === 'tools/list' && message.id !== undefined) {",
  "    send({ jsonrpc: '2.0', id: message.id, result: { tools } })",
  '    return',
  '  }',
  "  if (message.method === 'tools/call' && message.id !== undefined) {",
  '    const name = message.params && message.params.name',
  '    const args = (message.params && message.params.arguments) || {}',
  "    if (name === 'echo') { send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(args) }] } }); return }",
  "    if (name === 'fail') { send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'invalid_arguments: value 必须是数字' }] } }); return }",
  "    if (name === 'slow') return",
  "    if (name === 'crash') { process.exit(3); return }",
  "    if (name === 'garbage') { process.stdout.write('this is not json\\n'); return }",
  "    if (name === 'huge') { send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'X'.repeat(60000) }] } }); return }",
  "    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown tool: ' + name } })",
  '    return',
  '  }',
  "  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })",
  '})',
  "process.on('SIGTERM', () => process.exit(0))",
  "process.on('SIGINT', () => process.exit(0))"
].join('\n')

/* ── 测试环境 ─────────────────────────────────────────────────── */

const tempDirs: string[] = []
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['MORROW_MCP_CONFIG', 'MORROW_DATA_DIR', 'MORROW_MCP_TRUST_WORKSPACE'] as const

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morrow-mcp-'))
  tempDirs.push(dir)
  return dir
}

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

interface MockConfigOptions {
  dataDir?: string
  workspace?: string | null
  envConfigPath?: string
  extraServers?: Record<string, unknown>
  timeoutMs?: number
}

interface MockSetup {
  dir: string
  configPath: string
  scriptPath: string
  pidFile: string
}

/** 在临时目录造一个可用的 mock MCP server 与配置文件 */
function setupMock(options: MockConfigOptions = {}): MockSetup {
  const dir = makeTempDir()
  const scriptPath = join(dir, 'mock-mcp-server.cjs')
  const pidFile = join(dir, 'server.pid')
  const configPath = join(dir, 'mcp.json')
  writeFileSync(scriptPath, MOCK_SERVER_SOURCE, 'utf8')
  const mcpServers = {
    mock: {
      command: process.execPath,
      args: [scriptPath],
      env: { MOCK_MCP_PID_FILE: pidFile },
      timeoutMs: options.timeoutMs ?? 8000
    },
    ...(options.extraServers ?? {})
  }
  writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), 'utf8')
  if (options.envConfigPath !== undefined) setEnv('MORROW_MCP_CONFIG', options.envConfigPath)
  if (options.dataDir !== undefined) setEnv('MORROW_DATA_DIR', options.dataDir)
  return { dir, configPath, scriptPath, pidFile }
}

function makeCtx(workspace: string | null = null, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'session_mcp',
    runId: 'run_mcp',
    messageId: 'msg_mcp',
    toolUseId: 'tool_mcp',
    workspace,
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

function readPid(pidFile: string): number | null {
  try {
    return Number(readFileSync(pidFile, 'utf8').trim()) || null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitProcessGone(pid: number, timeoutMs = 4000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return !isProcessAlive(pid)
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      // 先清掉可能残留的 mock 进程，再删目录（Windows 下被占用的文件删不掉）
      const pidFile = join(dir, 'server.pid')
      const pid = readPid(pidFile)
      if (pid && isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // 已退出
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

/* ── 配置发现 ─────────────────────────────────────────────────── */

describe('MCP 配置发现', () => {
  it('MORROW_MCP_CONFIG 优先于数据目录与工作区配置', async () => {
    const dataDir = makeTempDir()
    const workspace = makeTempDir()
    setupMock({ dataDir })
    writeFileSync(join(dataDir, 'mcp.json'), JSON.stringify({ mcpServers: { data_server: { command: 'x', args: [] } } }))
    const envDir = makeTempDir()
    const envConfig = join(envDir, 'mcp.json')
    writeFileSync(envConfig, JSON.stringify({ mcpServers: { env_server: { command: 'y', args: [] } } }))
    setEnv('MORROW_MCP_CONFIG', envConfig)

    const loaded = await loadMcpConfig({ workspace })
    expect(loaded.found).toBe(true)
    expect(loaded.source).toBe('env')
    expect(loaded.path).toBe(envConfig)
    expect(loaded.servers.map((server) => server.name)).toContain('env_server')
    expect(loaded.servers.map((server) => server.name)).not.toContain('data_server')
  })

  it('没有 env 时读数据目录 mcp.json，再退到工作区 .morrow/mcp.json', async () => {
    const dataDir = makeTempDir()
    const workspace = makeTempDir()
    writeFileSync(join(dataDir, 'mcp.json'), JSON.stringify({ mcpServers: { data_server: { command: 'x' } } }))
    const fromDataDir = await loadMcpConfig({ workspace, dataDir })
    expect(fromDataDir.source).toBe('dataDir')
    expect(fromDataDir.servers.map((server) => server.name)).toEqual(['data_server'])
    expect(fromDataDir.trusted).toBe(true)

    rmSync(join(dataDir, 'mcp.json'))
    writeFileSync(join(workspace, 'mcp.json'), '{}')
    // 工作区配置在 .morrow/mcp.json
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(workspace, '.morrow'), { recursive: true })
    writeFileSync(join(workspace, '.morrow', 'mcp.json'), JSON.stringify({ mcpServers: { ws_server: { command: 'z' } } }))
    const fromWorkspace = await loadMcpConfig({ workspace, dataDir })
    expect(fromWorkspace.source).toBe('workspace')
    expect(fromWorkspace.trusted).toBe(false)
    expect(fromWorkspace.servers.map((server) => server.name)).toEqual(['ws_server'])
  })

  it('resolveMcpDataDir：显式参数 > MORROW_DATA_DIR > 平台默认', () => {
    expect(resolveMcpDataDir({ dataDir: 'C:\\custom', env: {} })).toBe('C:\\custom')
    expect(resolveMcpDataDir({ env: { MORROW_DATA_DIR: 'C:\\from-env' } })).toBe('C:\\from-env')
    expect(resolveMcpDataDir({ env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' } })).toBe('C:\\Users\\tester\\AppData\\Roaming\\Morrow')
    expect(resolveMcpDataDir({ dataDir: 'C:\\explicit', env: { MORROW_DATA_DIR: 'C:\\from-env' } })).toBe('C:\\explicit')
  })

  it('配置不是合法 JSON 时给出带路径的友好错误', async () => {
    const dir = makeTempDir()
    const configPath = join(dir, 'mcp.json')
    writeFileSync(configPath, '{ "mcpServers": { oops }', 'utf8')
    setEnv('MORROW_MCP_CONFIG', configPath)
    await expect(loadMcpConfig({ workspace: dir })).rejects.toMatchObject({ name: 'McpError', kind: 'config' })
  })
})

/* ── mcp_list ─────────────────────────────────────────────────── */

describe('mcp_list', () => {
  it('列出 server 与工具 schema，并声明外部内容不可信', async () => {
    const setup = setupMock()
    setEnv('MORROW_MCP_CONFIG', setup.configPath)
    const tool = createMcpTools().mcpListTool
    const result = await tool.execute({}, makeCtx())
    expect(result.ok).toBe(true)
    expect(result.output).toContain('mock')
    expect(result.output).toContain('echo')
    expect(result.output).toContain('fail')
    expect(result.output).toContain('不可信')
    expect(result.output).toContain('mcp.json')
    expect(result.meta).toMatchObject({ source: 'env', trusted: true })
    const pid = readPid(setup.pidFile)
    expect(pid).toBeTruthy()
    expect(await waitProcessGone(pid as number)).toBe(true)
  })

  it('未配置时返回可操作的说明（不是「工具坏了」）', async () => {
    const workspace = makeTempDir()
    const dataDir = makeTempDir()
    const tool = createMcpTools().mcpListTool
    const result = await tool.execute({}, makeCtx(workspace))
    expect(result.ok).toBe(true)
    expect(result.output).toContain('未配置')
    expect(result.output).toContain('mcp.json')
    // 数据目录候选也应在 searched 里（通过环境变量注入）
    setEnv('MORROW_DATA_DIR', dataDir)
    const second = await tool.execute({}, makeCtx(workspace))
    expect(second.output).toContain(dataDir)
  })

  it('单个 server 启动失败不影响其它 server，并给出诊断', async () => {
    const setup = setupMock({
      extraServers: { broken: { command: 'definitely-not-a-real-command-xyz', args: [], timeoutMs: 2000 } }
    })
    setEnv('MORROW_MCP_CONFIG', setup.configPath)
    const result = await createMcpTools().mcpListTool.execute({}, makeCtx())
    expect(result.ok).toBe(true)
    expect(result.output).toContain('echo')
    expect(result.output).toContain('broken')
    expect(result.output).toMatch(/启动失败|连接失败/)
  })

  it('HTTP/SSE 传输已支持：列表会尝试连接，失败时给出明确诊断而不是「不支持」', async () => {
    const dir = makeTempDir()
    const configPath = join(dir, 'mcp.json')
    // 127.0.0.1 未开 allowPrivateNetwork → 应被 SSRF 拒绝（连接失败），而不是「暂不支持」
    writeFileSync(configPath, JSON.stringify({ mcpServers: { remote: { transport: 'http', url: 'http://127.0.0.1:1/mcp' } } }), 'utf8')
    setEnv('MORROW_MCP_CONFIG', configPath)
    const result = await createMcpTools().mcpListTool.execute({}, makeCtx())
    expect(result.ok).toBe(false)
    expect(result.output).toContain('remote')
    expect(result.output).toContain('连接失败')
    expect(result.output).not.toContain('暂不支持 HTTP')
  })

  it('工作区配置默认只列 server 名、不启动其中的命令（供应链安全）', async () => {
    const workspace = makeTempDir()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(workspace, '.morrow'), { recursive: true })
    const setup = setupMock()
    const workspaceConfig = JSON.parse(readFileSync(setup.configPath, 'utf8')) as Record<string, unknown>
    writeFileSync(join(workspace, '.morrow', 'mcp.json'), JSON.stringify(workspaceConfig), 'utf8')
    const result = await createMcpTools().mcpListTool.execute({}, makeCtx(workspace))
    expect(result.ok).toBe(true)
    expect(result.output).toContain('mock')
    expect(result.output).toMatch(/项目级/)
    expect(existsSync(setup.pidFile)).toBe(false)

    setEnv('MORROW_MCP_TRUST_WORKSPACE', '1')
    const trusted = await createMcpTools().mcpListTool.execute({}, makeCtx(workspace))
    expect(trusted.output).toContain('echo')
    expect(existsSync(setup.pidFile)).toBe(true)
  })
})

/* ── mcp_call ─────────────────────────────────────────────────── */

describe('mcp_call', () => {
  it('调用工具成功：返回内容、来源与「不可信」声明', async () => {
    const setup = setupMock()
    setEnv('MORROW_MCP_CONFIG', setup.configPath)
    const result = await createMcpTools().mcpCallTool.execute(
      { server: 'mock', tool: 'echo', arguments: { text: 'hello' } },
      makeCtx()
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain('hello')
    expect(result.output).toContain('mock.echo')
    expect(result.output).toContain('不可信')
    expect(result.meta).toMatchObject({ server: 'mock', tool: 'echo', isError: false })
    const pid = readPid(setup.pidFile)
    expect(pid).toBeTruthy()
    expect(await waitProcessGone(pid as number)).toBe(true)
  })

  it('MCP 工具返回错误（isError）时不当作成功', async () => {
    const setup = setupMock()
    setEnv('MORROW_MCP_CONFIG', setup.configPath)
    const result = await createMcpTools().mcpCallTool.execute({ server: 'mock', tool: 'fail' }, makeCtx())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('invalid_arguments')
    expect(result.hint).toBeTruthy()
  })

  it('未知 server / 未知 tool 给出可用清单与建议', async () => {
    const setup = setupMock()
    setEnv('MORROW_MCP_CONFIG', setup.configPath)
    const unknownServer = await createMcpTools().mcpCallTool.execute({ server: 'nope', tool: 'echo' }, makeCtx())
    expect(unknownServer.ok).toBe(false)
    expect(unknownServer.error).toContain('nope')
    expect(unknownServer.error).toContain('mock')

    const unknownTool = await createMcpTools().mcpCallTool.execute({ server: 'mock', tool: 'nope' }, makeCtx())
    expect(unknownTool.ok).toBe(false)
    expect(unknownTool.error).toMatch(/未知工具|unknown tool/)
  })

  it('调用超时：报超时并杀掉 MCP server 进程', async () => {
    const setup = setupMock({ timeoutMs: 500 })
    setEnv('MORROW_MCP_CONFIG', setup.configPath)
    const started = Date.now()
    const result = await createMcpTools().mcpCallTool.execute({ server: 'mock', tool: 'slow' }, makeCtx())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('超时')
    expect(Date.now() - started).toBeLessThan(5000)
    const pid = readPid(setup.pidFile)
    expect(pid).toBeTruthy()
    expect(await waitProcessGone(pid as number)).toBe(true)
  })

  it('协议脏数据（非法 JSON）报告协议错误并清理进程', async () => {
    const setup = setupMock()
    setEnv('MORROW_MCP_CONFIG', setup.configPath)
    const result = await createMcpTools().mcpCallTool.execute({ server: 'mock', tool: 'garbage' }, makeCtx())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/协议|JSON/)
    const pid = readPid(setup.pidFile)
    expect(pid).toBeTruthy()
    expect(await waitProcessGone(pid as number)).toBe(true)
  })

  it('server 进程中途退出时返回可理解错误', async () => {
    const setup = setupMock()
    setEnv('MORROW_MCP_CONFIG', setup.configPath)
    const result = await createMcpTools().mcpCallTool.execute({ server: 'mock', tool: 'crash' }, makeCtx())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/退出/)
  })

  it('输出超过上限时截断（不会把几十 KB 塞进上下文）', async () => {
    const setup = setupMock()
    setEnv('MORROW_MCP_CONFIG', setup.configPath)
    const result = await createMcpTools().mcpCallTool.execute({ server: 'mock', tool: 'huge' }, makeCtx())
    expect(result.ok).toBe(true)
    expect(result.output.length).toBeLessThan(25_000)
    expect(result.meta?.truncated).toBe(true)
  })

  it('参数校验：server/tool 必填、arguments 必须是对象', async () => {
    const setup = setupMock()
    setEnv('MORROW_MCP_CONFIG', setup.configPath)
    const tool = createMcpTools().mcpCallTool
    expect((await tool.execute({ tool: 'echo' }, makeCtx())).ok).toBe(false)
    expect((await tool.execute({ server: 'mock' }, makeCtx())).ok).toBe(false)
    const badArgs = await tool.execute({ server: 'mock', tool: 'echo', arguments: 'not-an-object' }, makeCtx())
    expect(badArgs.ok).toBe(false)
    expect(badArgs.error).toContain('arguments')
  })

  it('未配置 / 工作区配置未信任时拒绝调用（明确说明原因）', async () => {
    const workspace = makeTempDir()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(workspace, '.morrow'), { recursive: true })
    const setup = setupMock()
    writeFileSync(join(workspace, '.morrow', 'mcp.json'), readFileSync(setup.configPath))
    const tool = createMcpTools().mcpCallTool
    const untrusted = await tool.execute({ server: 'mock', tool: 'echo' }, makeCtx(workspace))
    expect(untrusted.ok).toBe(false)
    expect(untrusted.error).toMatch(/项目级|信任/)
    expect(existsSync(setup.pidFile)).toBe(false)

    const missing = await tool.execute({ server: 'mock', tool: 'echo' }, makeCtx())
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('未配置')
  })

  it('已中断的 signal：直接抛中断错误（Agent 会标记为 interrupted）', async () => {
    const setup = setupMock()
    setEnv('MORROW_MCP_CONFIG', setup.configPath)
    const controller = new AbortController()
    controller.abort()
    const tool = createMcpTools().mcpCallTool
    await expect(tool.execute({ server: 'mock', tool: 'echo' }, makeCtx(null, { signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})

/* ── 注册与权限语义 ───────────────────────────────────────────── */

describe('MCP 工具注册与权限语义', () => {
  it('mcp_list 是 meta（只读模式可列、子代理拿不到）', () => {
    expect(toolCategory('mcp_list')).toBe('meta')
    expect(toolRiskFor('mcp_list')).toBe('low')
  })

  it('mcp_call 是 exec + high（必须走审批），且 schema 只有 server/tool/arguments', () => {
    expect(toolCategory('mcp_call')).toBe('exec')
    expect(toolRiskFor('mcp_call')).toBe('high')
    const tool = createMcpTools().mcpCallTool
    const parameters = tool.definition.parameters as { required?: string[]; properties: Record<string, unknown> }
    expect(parameters.required).toEqual(['server', 'tool'])
    expect(Object.keys(parameters.properties).sort()).toEqual(['arguments', 'server', 'tool'])
    expect(tool.definition.titleFor({ server: 'mock', tool: 'echo' })).toContain('mock.echo')
  })

  it('web_fetch / mcp_list / mcp_call 已注册进 registry，子代理只读工具集不包含它们', async () => {
    const defs = (await import('../../../src/core/tools/registry')).TOOL_DEFINITIONS.map((tool) => tool.name)
    expect(defs).toContain('web_fetch')
    expect(defs).toContain('mcp_list')
    expect(defs).toContain('mcp_call')
    const readOnly = (await import('../../../src/core/tools/registry')).READ_ONLY_TOOL_DEFINITIONS.map((tool) => tool.name)
    expect(readOnly).not.toContain('web_fetch')
    expect(readOnly).not.toContain('mcp_call')
    expect(readOnly).not.toContain('mcp_list')
  })

  it('executeTool 走 registry 时能执行 mcp_list；子代理（readOnly）被拦截', async () => {
    const setup = setupMock()
    setEnv('MORROW_MCP_CONFIG', setup.configPath)
    const result = await executeTool('mcp_list', {}, makeCtx())
    expect(result.ok).toBe(true)
    expect(result.output).toContain('echo')

    const asSubagent = await executeTool('mcp_list', {}, makeCtx(null, { readOnly: true }))
    expect(asSubagent.ok).toBe(false)
    expect(asSubagent.error).toContain('只读')
  })
})
