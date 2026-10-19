/**
 * R10-G 连接器管理面板 E2E（真实 Electron + 真实主进程 feature IPC + 真实文件/加密）。
 *
 * 无 LLM、不联网、不产生费用：
 * 1. 打开工作台 → 连接器面板（Lead 已挂载到 Workbench）；
 * 2. 通过面板 UI 添加 Streamable HTTP MCP 连接器（本地 mock server），测试连接 → 工具列表；
 * 3. 保存后验证真实落盘：`<dataDir>/mcp.json` 只有 `$MORROW_SECRET:` 标记，密钥加密文件无明文；
 * 4. 再次测试已保存连接器：解密后的 Authorization 请求头真实发到 mock server；
 * 5. 启停开关、SSRF 拒绝（localhost 未勾选 allowPrivateNetwork）、file:// 协议拒绝、删除清理；
 * 6. templates 全部 exampleOnly（不伪造内置服务）；截图深色面板。
 */
import { expect, test } from '@playwright/test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchMorrow, screenshotPath, type MorrowApp } from './launch'
import { dismissOnboarding, waitForStoreReady } from './store'

type InvokeResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

interface MockMcpServer {
  url: string
  requests: Array<{ method: string; headers: IncomingMessage['headers']; body: Record<string, unknown> | null }>
  close: () => Promise<void>
}

const INITIALIZE_RESULT = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  serverInfo: { name: 'e2e-mock-http', version: '1.0.0' }
}

const TOOLS_RESULT = {
  tools: [
    {
      name: 'echo',
      description: '原样返回参数（E2E mock）',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    },
    { name: 'list_items', description: '分页清单', inputSchema: { type: 'object', properties: {} } }
  ]
}

/** 本地 Streamable HTTP MCP mock：POST JSON-RPC / JSON 响应 / Mcp-Session-Id */
async function startMockMcp(): Promise<MockMcpServer> {
  const sockets = new Set<Socket>()
  const requests: MockMcpServer['requests'] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let message: Record<string, unknown> | null = null
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        message = null
      }
      requests.push({ method: typeof message?.method === 'string' ? message.method : '', headers: req.headers, body: message })
      if (!message) {
        res.writeHead(400)
        res.end()
        return
      }
      const reply = (result: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(200, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message?.id, result }))
      }
      if (message.method === 'initialize') {
        reply(INITIALIZE_RESULT, { 'Mcp-Session-Id': 'e2e-session' })
        return
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      if (message.method === 'tools/list') {
        reply(TOOLS_RESULT)
        return
      }
      if (message.method === 'tools/call') {
        const params = (message.params ?? {}) as Record<string, unknown>
        reply({ content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] })
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock MCP server 未监听')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}

async function invoke<T>(page: MorrowApp['page'], channel: string, payload?: unknown): Promise<InvokeResult<T>> {
  return page.evaluate(
    async (arg: { channel: string; payload?: unknown }) => {
      return window.morrow.features.invoke(arg.channel, arg.payload) as Promise<InvokeResult<T>>
    },
    { channel, payload }
  )
}

function readMcpJson(dataDir: string): { mcpServers: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dataDir, 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, Record<string, unknown>>
  }
}

async function openConnectorsPanel(morrow: MorrowApp): Promise<void> {
  const { page } = morrow
  await dismissOnboarding(page)
  await waitForStoreReady(page)
  await page.locator('[aria-label="打开工作台 (Ctrl+Shift+W)"]').click()
  await expect(page.locator('.workbench-card').filter({ hasText: '连接器' })).toBeVisible()
  await page.locator('.workbench-card').filter({ hasText: '连接器' }).click()
  await expect(page.getByTestId('connectors-panel')).toBeVisible({ timeout: 15_000 })
}

test.describe('R10-G 连接器管理面板', () => {
  let morrow: MorrowApp | null = null
  let mock: MockMcpServer | null = null

  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
    await mock?.close()
    mock = null
  })

  test('HTTP 连接器：测试连接 → 保存（密钥加密）→ 再测（解密发请求）→ 启停 → SSRF/文件协议拒绝 → 删除', async () => {
    mock = await startMockMcp()
    morrow = await launchMorrow({ name: 'r10-connectors', waitForSelector: '.sidebar' })
    const { page, dataDir } = morrow
    await openConnectorsPanel(morrow)

    // feature IPC 已注册：templates 全部是「仅示例」，不伪造内置服务
    const templates = await invoke<Array<{ exampleOnly: boolean }>>(page, 'feature:connectors:templates', {})
    expect(templates.ok).toBe(true)
    if (templates.ok) {
      expect(templates.data.length).toBeGreaterThanOrEqual(4)
      expect(templates.data.every((item) => item.exampleOnly === true)).toBe(true)
    }

    // ── 1) 添加 HTTP 连接器（未勾选允许本机 → 先看 SSRF 拒绝）
    await page.getByRole('button', { name: '添加连接器' }).click()
    await page.getByLabel('名称').fill('e2e-http')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('MCP endpoint URL').fill(mock.url)

    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.locator('.conn-test-error')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.conn-test-reason')).toHaveText('ssrf-blocked')
    await expect(page.locator('.conn-test-error')).toContainText('允许访问本机/内网地址')

    // 勾选显式允许本机地址后测试成功
    await page.getByRole('switch', { name: '允许访问本机/内网地址' }).click()
    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.locator('.conn-test-ok')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.conn-test-ok')).toContainText('连接成功')
    await expect(page.locator('.conn-test-ok')).toContainText('echo')
    await expect(page.locator('.conn-test-ok')).toContainText('list_items')

    // ── 2) 加一个鉴权请求头（密钥只写不读）
    await page.locator('.conn-secrets').getByRole('button', { name: '添加' }).click()
    await page.getByLabel('请求头 headers键名').fill('Authorization')
    await page.getByLabel('请求头 headers值').fill('Bearer e2e-secret-token')

    // ── 3) 保存并验证真实落盘（加密标记，无明文）
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })).toBeVisible({ timeout: 15_000 })
    const config = readMcpJson(dataDir)
    const saved = config.mcpServers['e2e-http']
    expect(saved).toBeTruthy()
    expect(saved.transport).toBe('http')
    expect(saved.url).toBe(mock.url)
    const headers = saved.headers as Record<string, string>
    expect(headers.Authorization.startsWith('$MORROW_SECRET:')).toBe(true)
    const rawConfigText = readFileSync(join(dataDir, 'mcp.json'), 'utf8')
    expect(rawConfigText).not.toContain('e2e-secret-token')
    expect(existsSync(join(dataDir, 'mcp-secrets.json'))).toBe(true)
    const secretsText = readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')
    expect(secretsText).not.toContain('e2e-secret-token')

    // 列表视图只显示掩码，渲染层拿不到明文
    const list = await invoke<{ connectors: Array<{ name: string; headers: Array<{ masked: string; hasSecret: boolean }> }> }>(
      page,
      'feature:connectors:list',
      { scope: 'user' }
    )
    expect(list.ok).toBe(true)
    if (list.ok) {
      const view = list.data.connectors.find((item) => item.name === 'e2e-http')
      expect(view?.headers[0]).toMatchObject({ masked: '••••••••', hasSecret: true })
      expect(JSON.stringify(list.data)).not.toContain('e2e-secret-token')
    }

    // ── 4) 再测已保存连接器：主进程解密密钥，Authorization 真实到达 mock server
    mock.requests.length = 0
    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.locator('.conn-test-ok')).toBeVisible({ timeout: 20_000 })
    const toolsListRequest = mock.requests.find((request) => request.method === 'tools/list')
    expect(toolsListRequest?.headers.authorization).toBe('Bearer e2e-secret-token')
    expect(toolsListRequest?.headers['mcp-session-id']).toBe('e2e-session')

    // 截图证据 2：工具列表与测试结果（滚到编辑区底部）
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r10-connectors-tools.png') })

    // 截图证据 1（面板 + 已保存连接器）：把两栏滚回顶部，保证截图完整
    await page.locator('.modal-body').evaluate((element) => {
      element.scrollTop = 0
    })
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = 0
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('r10-connectors-panel.png') })

    // ── 5) 启停开关真实写盘
    const item = page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })
    await item.getByRole('switch').click()
    await expect
      .poll(() => readMcpJson(dataDir).mcpServers['e2e-http']?.disabled, { timeout: 10_000 })
      .toBe(true)
    await item.getByRole('switch').click()
    await expect
      .poll(() => readMcpJson(dataDir).mcpServers['e2e-http']?.disabled, { timeout: 10_000 })
      .toBeUndefined()

    // ── 6) file:// 协议被配置校验拒绝
    await page.getByRole('button', { name: '添加连接器' }).click()
    await page.getByLabel('名称').fill('e2e-bad-url')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('MCP endpoint URL').fill('file:///C:/Windows/win.ini')
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByRole('alert').filter({ hasText: '操作失败' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('alert').filter({ hasText: '操作失败' })).toContainText('只允许 http://')
    await page.getByRole('button', { name: '取消' }).click()

    // ── 7) 删除连接器：列表与磁盘都清理
    await page.getByTestId('connector-item').filter({ hasText: 'e2e-http' }).locator('.conn-item-main').click()
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('button', { name: '确认删除' }).click()
    await expect(page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })).toHaveCount(0, { timeout: 15_000 })
    await expect
      .poll(() => readMcpJson(dataDir).mcpServers['e2e-http'] ?? null, { timeout: 10_000 })
      .toBeNull()
    const secretsAfterDelete = JSON.parse(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')) as {
      entries: Record<string, string>
    }
    expect(Object.keys(secretsAfterDelete.entries).filter((key) => key.includes('e2e-http'))).toHaveLength(0)
  })

  test('工作区级配置：未打开工作区时明确提示，且不写入 .morrow', async () => {
    morrow = await launchMorrow({ name: 'r10-connectors-ws', waitForSelector: '.sidebar' })
    const { page, dataDir } = morrow
    await openConnectorsPanel(morrow)

    await page.getByRole('radio', { name: '工作区级' }).click()
    await expect(page.getByTestId('connectors-panel')).toContainText('需要先打开一个工作区文件夹')

    // 用户级配置路径可见；工作区级路径不存在
    const paths = await invoke<{ userConfigPath: string; workspaceConfigPath: string | null }>(page, 'feature:connectors:paths', {})
    expect(paths.ok).toBe(true)
    if (paths.ok) {
      expect(paths.data.userConfigPath.startsWith(dataDir)).toBe(true)
      expect(paths.data.workspaceConfigPath).toBeNull()
    }

    // 切换回用户级仍可用
    await page.getByRole('radio', { name: '用户级' }).click()
    await expect(page.getByRole('button', { name: '添加连接器' })).toBeVisible()
  })
})
