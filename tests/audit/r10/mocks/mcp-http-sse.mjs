/**
 * R10 MCP HTTP / SSE 验收 mock（仅 127.0.0.1，零外网）。
 *
 * - POST /mcp：JSON-RPC 2.0（initialize / tools/list / tools/call）；
 * - GET /sse：SSE 流，先发 endpoint 事件；POST /messages 接受 JSON-RPC；
 * - tools：echo、slow（可配延迟/超时）、big（大响应，测上限）、bad（isError）、secret（测 SSRF/密钥不出现在错误中）。
 *
 * 仅用于审计 fixture，不是产品实现。
 */
import { createServer } from 'node:http'

const TOOLS = [
  { name: 'echo', description: '原样返回输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'slow', description: '延迟返回（测超时）', inputSchema: { type: 'object', properties: { delayMs: { type: 'number' } } } },
  { name: 'big', description: '大响应（测消息上限）', inputSchema: { type: 'object', properties: {} } },
  { name: 'bad', description: '业务错误（isError）', inputSchema: { type: 'object', properties: {} } }
]

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
function textContent(payload, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError }
}

async function callTool(name, args = {}) {
  if (name === 'echo') return rpcResult(0, textContent({ echo: args.text ?? '' }))
  if (name === 'slow') {
    const delay = Math.max(0, Number(args.delayMs ?? 2000))
    await new Promise((resolve) => setTimeout(resolve, delay))
    return rpcResult(0, textContent({ slow: true, delay }))
  }
  if (name === 'big') return rpcResult(0, textContent({ text: 'x'.repeat(200_000) }))
  if (name === 'bad') return rpcResult(0, textContent({ error: 'synthetic_business_error' }, true))
  return rpcError(0, -32602, `unknown tool: ${name}`)
}

export function createMcpHttpSseFixture() {
  const state = { requests: [], calls: [], sseClients: [], sessions: 0 }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/sse') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      const sessionId = `r10-sse-${++state.sessions}`
      res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`)
      state.sseClients.push(res)
      req.on('close', () => {
        state.sseClients = state.sseClients.filter((client) => client !== res)
      })
      return
    }
    const readBody = () =>
      new Promise((resolve) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      })
    const body = await readBody()
    let message = null
    try {
      message = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify(rpcError(null, -32700, 'parse error')))
      return
    }
    state.requests.push({ path: url.pathname, method: req.method, message })
    if (req.method === 'POST' && (url.pathname === '/mcp' || url.pathname === '/messages')) {
      const { id, method, params } = message
      let response
      if (method === 'initialize') {
        response = rpcResult(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'r10-mcp-http-fixture', version: '1.0.0' }
        })
      } else if (method === 'notifications/initialized' || method === 'initialized') {
        response = null
      } else if (method === 'tools/list') {
        response = rpcResult(id, { tools: TOOLS })
      } else if (method === 'tools/call') {
        const name = params?.name
        state.calls.push({ name, arguments: params?.arguments ?? {} })
        response = await callTool(name, params?.arguments ?? {})
        if (response?.result) response = { jsonrpc: '2.0', id, result: response.result }
      } else {
        response = rpcError(id, -32601, `method not found: ${method}`)
      }
      if (url.pathname === '/messages') res.writeHead(202, { 'content-type': 'text/plain' })
      else res.writeHead(200, { 'content-type': 'application/json' })
      res.end(response ? JSON.stringify(response) : '')
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(rpcError(null, -32000, 'not found')))
  })
  server.on('close', () => {
    for (const client of state.sseClients) client.end()
    state.sseClients = []
  })
  return { server, state }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`) {
  const { server } = createMcpHttpSseFixture()
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    console.log(JSON.stringify({ ok: true, baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` }))
  })
}
