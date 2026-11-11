import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHttpRequestTool } from '../../src/core/tool-media'
import type { ToolContext } from '../../src/core/types'

let server: Server | null = null
let base = ''
const requests: Array<{ method?: string; url?: string; headers?: Record<string, string | string[] | undefined>; body?: string }> = []

function context(): ToolContext {
  return {
    sessionId: 's1',
    runId: 'r1',
    messageId: 'm1',
    toolUseId: 't1',
    workspace: null,
    permissionMode: 'auto',
    snapshotDir: '',
    signal: new AbortController().signal,
    depth: 0,
    readOnly: false,
    escapeApproved: false,
    demo: false,
    goal: null,
    planMode: false,
    getPlan: () => null,
    proposePlan: (plan) => plan,
    emit: () => undefined,
    updateGoal: () => null,
    getTodos: () => [],
    setTodos: () => undefined,
    getArtifacts: () => [],
    addArtifact: () => undefined,
    askUser: async () => ({ value: 'ok', label: 'ok' }),
    progress: () => undefined,
    runSwarmMember: async () => ({
      status: 'failed' as const,
      summary: '',
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0 }
    })
  } as ToolContext
}

beforeEach(async () => {
  requests.length = 0
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/echo' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-test': 'yes' })
      res.end(JSON.stringify({ method: req.method, body, header: req.headers['x-demo'] ?? null }))
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
})

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

describe('http-request.test.ts', () => {
  it('@core:web POST 请求真实发送自定义头和请求体', async () => {
    const tool = createHttpRequestTool({ allowPrivateNetwork: true })
    const result = await tool.execute(
      {
        url: `${base}/echo`,
        method: 'POST',
        headers: { 'X-Demo': 'morrow', Host: 'evil.example', 'Content-Length': '999' },
        body: '{"hello":"world"}'
      },
      context()
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain('HTTP 200')
    expect(result.output).toContain('"method":"POST"')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.body).toBe('{"hello":"world"}')
    expect(requests[0]?.headers?.['x-demo']).toBe('morrow')
    expect(requests[0]?.headers?.host).toContain('127.0.0.1')
  })

  it('@core:web 302 不自动跟随，返回重定向地址供人确认', async () => {
    const tool = createHttpRequestTool({ allowPrivateNetwork: true })
    const result = await tool.execute({ url: `${base}/redirect`, method: 'GET' }, context())
    expect(result.ok).toBe(true)
    expect(result.output).toContain('HTTP 302')
    expect(result.output).toContain('重定向到：/echo')
    expect(requests).toHaveLength(1)
    expect(result.meta?.redirectTo).toBe('/echo')
  })

  it('@core:web 默认拒绝 localhost/内网，不发出请求', async () => {
    const tool = createHttpRequestTool()
    const result = await tool.execute({ url: `${base}/echo`, method: 'GET' }, context())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('内网')
    expect(requests).toHaveLength(0)
  })

  it('@core:web 拒绝非法方法和过大请求体', async () => {
    const tool = createHttpRequestTool({ allowPrivateNetwork: true })
    const badMethod = await tool.execute({ url: `${base}/echo`, method: 'TRACE' }, context())
    expect(badMethod.ok).toBe(false)
    const bigBody = await tool.execute(
      { url: `${base}/echo`, method: 'POST', body: 'x'.repeat(300 * 1024) },
      context()
    )
    expect(bigBody.ok).toBe(false)
    expect(requests).toHaveLength(0)
  })
})
