/**
 * R10-G 连接器管理面板 E2E（真实 Electron + 真实主进程 feature IPC + 真实文件/加密）。
 *
 * 无 LLM、不联网、不产生费用：
 * 1. 从设置 → 功能与工具打开连接器面板；
 * 2. 通过面板 UI 添加 Streamable HTTP MCP 连接器（本地 mock server），测试连接 → 工具列表；
 * 3. 保存后验证真实落盘：`<dataDir>/mcp.json` 只有 `$MORROW_SECRET:` 标记，密钥加密文件无明文；
 * 4. 再次测试已保存连接器：解密后的 Authorization 请求头真实发到 mock server；
 * 5. 启停开关、SSRF 拒绝（localhost 未勾选 allowPrivateNetwork）、file:// 协议拒绝、删除清理；
 * 6. catalog 条目名合法、地址与运行时字段完整；截图深色面板。
 */
import { expect, test } from '@playwright/test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchMorrow, screenshotPath, type MorrowApp } from './launch'
import { dismissOnboarding, openToolPanel, setThemeViaStore, waitForStoreReady } from './store'

type InvokeResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

interface MockMcpServer {
  url: string
  requests: Array<{ method: string; headers: IncomingMessage['headers']; body: Record<string, unknown> | null }>
  close: () => Promise<void>
}

const INITIALIZE_RESULT = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {}, resources: {}, prompts: {} },
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
      if (message.method === 'resources/list') {
        reply({ resources: [{ uri: 'memo://notes/1', name: 'Notes', mimeType: 'text/plain' }] })
        return
      }
      if (message.method === 'resources/templates/list') {
        reply({ resourceTemplates: [{ uriTemplate: 'memo://notes/{id}', name: 'Note' }] })
        return
      }
      if (message.method === 'resources/read') {
        reply({ contents: [{ uri: 'memo://notes/1', mimeType: 'text/plain', text: '# Note' }] })
        return
      }
      if (message.method === 'prompts/list') {
        reply({ prompts: [{ name: 'summarize', description: '总结主题', arguments: [{ name: 'topic', required: true }] }] })
        return
      }
      if (message.method === 'prompts/get') {
        reply({ messages: [{ role: 'user', content: { type: 'text', text: '请总结：MCP' } }] })
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
  await openToolPanel(page, '连接器')
  await expect(page.getByTestId('connectors-panel')).toBeVisible({ timeout: 15_000 })
  // 外层模态不滚动；左右两栏各自在面板内部滚动
  const bodyOverflow = await page
    .getByRole('dialog', { name: '外部工具（MCP）' })
    .evaluate((panel) => {
      const body = panel.querySelector<HTMLElement>('.modal-body')
      return body ? body.scrollHeight - body.clientHeight : null
    })
  expect(bodyOverflow).not.toBeNull()
  expect(bodyOverflow!).toBeLessThanOrEqual(1)
  const pathFits = await page.locator('.conn-path').evaluate((element) => {
    return element.clientHeight > 0 && element.scrollHeight <= element.clientHeight + 1
  })
  expect(pathFits).toBe(true)
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

    // feature IPC 已注册：目录条目名称合法、远程/本机字段完整
    const catalog = await invoke<{ entries: Array<{ name: string; transport: string; requiresNpx: boolean; docsUrl: string }> }>(
      page,
      'feature:connectors:catalog',
      {}
    )
    expect(catalog.ok).toBe(true)
    if (catalog.ok) {
      expect(catalog.data.entries.length).toBeGreaterThanOrEqual(8)
      expect(catalog.data.entries.every((entry) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(entry.name))).toBe(true)
      expect(catalog.data.entries.every((entry) => entry.docsUrl.startsWith('https://'))).toBe(true)
    }

    // ── 1) 添加 HTTP 连接器（未勾选允许本机 → 先看 SSRF 拒绝）
    await page.getByRole('button', { name: '添加外部工具' }).click()
    await page.getByLabel('名称').fill('e2e-http')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('服务地址').fill(mock.url)

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
    await expect(page.locator('.conn-test-ok')).toContainText('1 个资源')
    await expect(page.locator('.conn-test-ok')).toContainText('1 个提示词')
    await expect(page.locator('.conn-catalog').filter({ hasText: 'memo://notes/1' })).toBeVisible()
    await expect(page.locator('.conn-catalog').filter({ hasText: 'summarize' })).toBeVisible()

    // ── 2) 加一个鉴权请求头（密钥只写不读）
    await page.locator('.conn-secrets').getByRole('button', { name: '添加' }).click()
    await page.getByLabel('请求头 headers键名').fill('Authorization')
    await page.getByLabel('请求头 headers值').fill('Bearer e2e-secret-token')

    // OAuth 端点保存后由后端加密保管令牌；这里验证 UI 字段与配置落盘
    await page.getByLabel('授权地址').fill('https://auth.example.com/oauth/authorize')
    await page.getByLabel('令牌地址').fill('https://auth.example.com/oauth/token')
    await page.getByLabel('Client ID').fill('e2e-client')
    await page.getByLabel('Scope（空格分隔）').fill('read write')
    await page.getByLabel('授权地址').scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('mcp-oauth-dark.png') })

    // ── 3) 保存并验证真实落盘（加密标记，无明文）
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })).toBeVisible({ timeout: 15_000 })
    const config = readMcpJson(dataDir)
    const saved = config.mcpServers['e2e-http']
    expect(saved).toBeTruthy()
    expect(saved.transport).toBe('http')
    expect(saved.url).toBe(mock.url)
    expect(saved.oauth).toMatchObject({
      authorizationUrl: 'https://auth.example.com/oauth/authorize',
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'e2e-client',
      scopes: ['read', 'write']
    })
    await expect(page.locator('.conn-oauth-status')).toContainText('未授权', { timeout: 10_000 })
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

    // 截图证据 1（面板 + 已保存连接器）：把编辑区滚回顶部，保证截图完整
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = 0
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('r10-connectors-panel.png') })

    // ── 4.1) 同名新建被拒绝：不得覆盖已有连接器或其密钥
    await page.getByRole('button', { name: '添加外部工具' }).click()
    await page.getByLabel('名称').fill('e2e-http')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('服务地址').fill('https://evil.example.com/mcp')
    await page.getByRole('button', { name: '保存' }).click()
    const duplicateAlert = page.getByRole('alert').filter({ hasText: '操作失败' })
    await expect(duplicateAlert).toBeVisible({ timeout: 10_000 })
    await expect(duplicateAlert).toContainText('已被另一个外部工具使用')
    const duplicateConfig = readMcpJson(dataDir).mcpServers['e2e-http']
    expect(duplicateConfig?.url).toBe(mock.url)
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = 0
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('connector-duplicate-name-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('connector-duplicate-name-dark.png') })
    await page.getByRole('button', { name: '取消' }).click()

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
    await page.getByRole('button', { name: '添加外部工具' }).click()
    await page.getByLabel('名称').fill('e2e-bad-url')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('服务地址').fill('file:///C:/Windows/win.ini')
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

    await page.getByRole('radio', { name: '当前文件夹' }).click()
    await expect(page.getByTestId('connectors-panel')).toContainText('需要先选择一个文件夹')

    // 用户级配置路径可见；工作区级路径不存在
    const paths = await invoke<{ userConfigPath: string; workspaceConfigPath: string | null }>(page, 'feature:connectors:paths', {})
    expect(paths.ok).toBe(true)
    if (paths.ok) {
      expect(paths.data.userConfigPath.startsWith(dataDir)).toBe(true)
      expect(paths.data.workspaceConfigPath).toBeNull()
    }

    // 切换回用户级仍可用
    await page.getByRole('radio', { name: '所有对话' }).click()
    await expect(page.getByRole('button', { name: '添加外部工具' })).toBeVisible()
  })
})
